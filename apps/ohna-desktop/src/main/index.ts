import { join } from "node:path";
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from "electron";
import { verifyPreloadSpike } from "./preload-spike.js";

const HTML_ENTRY = join(import.meta.dirname, "../renderer/index.html");
const WORKER_ENTRY = join(import.meta.dirname, "../utility/worker.js");

let mainWindow: BrowserWindow | undefined;
let worker: Electron.UtilityProcess | undefined;

/**
 * 启动 utilityProcess 并通过 parentPort 等待握手，再移交独立 MessagePort。
 *
 * @returns utilityProcess 实例与已连接的 MessagePort 客户端。
 */
async function startWorker(): Promise<{
  child: Electron.UtilityProcess;
  port: Electron.MessagePortMain;
}> {
  const child = utilityProcess.fork(WORKER_ENTRY, [], {
    serviceName: "ohna-desktop-spike-worker"
  });
  worker = child;

  const channel = new MessageChannelMain();
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("utilityProcess handshake timed out"));
    }, 5_000);

    child.once("spawn", () => {
      child.postMessage({ type: "connect" }, [channel.port1]);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`utilityProcess exited before handshake (code ${code ?? "unknown"})`));
    });
    child.once("message", (message) => {
      const readyMessage = message as { type?: string } | undefined;
      if (readyMessage?.type !== "ready") {
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
  });

  await ready;
  console.log("utilityProcess ready");
  // 先完成控制通道握手，再启动业务端口，确保 renderer IPC 不早于 worker 就绪。
  channel.port2.start();
  return { child, port: channel.port2 };
}

/**
 * 创建仅加载本地 renderer 的安全窗口。
 *
 * @returns 创建完成的窗口。
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 720,
    height: 480,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  void window.loadFile(HTML_ENTRY);
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  return window;
}

/**
 * 启动桌面窗口并登记 worker 探活 IPC。
 *
 * @returns 应用完成初始化后的 Promise。
 */
async function bootstrap(): Promise<void> {
  await app.whenReady();
  const workerProcess = await startWorker();
  const pending = new Map<number, (value: string) => void>();
  let nextRequestId = 0;

  workerProcess.port.on("message", (event) => {
    const response = event.data as { type?: string; id?: number } | undefined;
    if (response?.type !== "pong") {
      return;
    }

    const id = response.id;
    if (id === undefined) {
      return;
    }
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.("pong");
  });

  ipcMain.handle("spike:ping", () => {
    const id = nextRequestId++;
    return new Promise<string>((resolve) => {
      pending.set(id, resolve);
      workerProcess.port.postMessage({ type: "ping", id });
    });
  });

  mainWindow = createWindow();
  mainWindow.webContents.once("did-finish-load", () => {
    if (mainWindow) {
      void verifyPreloadSpike(mainWindow);
    }
  });

  app.on("activate", () => {
    if (!mainWindow) {
      mainWindow = createWindow();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  worker?.kill();
  worker = undefined;
});

void bootstrap();
