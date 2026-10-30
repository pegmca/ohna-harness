/**
 * 桌面主进程入口（spec §8.1 / §9）：单实例、窗口、原生工作区授权、IPC 路由与 runtime 宿主编排。
 *
 * 职责边界（spec §2.1）：主进程只做原生授权与 IPC 路由，不实现 Agent / 会话 / run / 存储；
 * 真正的执行核在 utilityProcess 的 `OhnaRuntime` 内，经 `RuntimeHost` 通过 MessagePort 通信。
 * 本文件保持极薄：只装配宿主、窗口与 IPC，不内联业务逻辑。
 */
import { app, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import {
  PICK_WORKSPACE_CHANNEL,
  FETCH_PROVIDER_MODELS_CHANNEL,
  READ_GIT_BRANCH_CHANNEL,
  READ_SETTINGS_CHANNEL,
  SAVE_SETTINGS_CHANNEL
} from "../preload/contract.js";
import { RuntimeHost } from "./runtime-host.js";
import { createUtilityTransport, DEFAULT_WORKER_ENTRY } from "./utility-transport.js";
import { registerIpc } from "./ipc.js";
import { WindowRegistry, createSecureWindow, loadSecureWindow } from "./windows.js";
import { deriveWorkspaceId, pickWorkspace, readGitBranch } from "./workspaces.js";
import type { WorkspaceDescriptorDto } from "@aiagent/types";
import { readSettings, writeSettings, type OhnaSettings } from "@aiagent/ohna-runtime";
import { createProxyAwareFetch } from "@aiagent/ai";
import { homedir } from "node:os";
import { join } from "node:path";

let mainWindow: import("electron").BrowserWindow | undefined;
let runtimeHost: RuntimeHost | undefined;
let unregisterIpc: (() => void) | undefined;
/** main 侧已授权工作区表：仅用于只读展示（如 Git 分支），执行授权仍以 runtime 为准。 */
const authorizedWorkspaces = new Map<string, WorkspaceDescriptorDto>();

/**
 * 创建并登记一个安全窗口，登记其 webContents.id 供 IPC sender 校验。
 *
 * @param windows 窗口归属登记器。
 * @returns 已创建的窗口。
 */
function createMainWindow(windows: WindowRegistry): import("electron").BrowserWindow {
  const window = createSecureWindow();
  window.once("ready-to-show", () => window.show());
  void loadSecureWindow(window);
  windows.register(window.webContents.id);
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
}

/**
 * 通过 host 把已授权工作区登记到 runtime（spec §6.1）。
 *
 * @param workspaceId 稳定工作区 ID。
 * @param workspaceRoot 规范绝对根目录（仅 main / runtime 持有）。
 * @returns runtime 登记后的描述符。
 */
async function registerWorkspaceWithHost(
  workspaceId: string,
  workspaceRoot: string
): Promise<WorkspaceDescriptorDto> {
  const res = await runtimeHost!.request({
    requestId: `ws-${workspaceId}`,
    method: "workspaces.register",
    payload: { workspaceId, workspaceRoot }
  });
  if (!res.ok || !res.data) {
    throw new Error(res.error?.message ?? "工作区登记失败");
  }
  const descriptor = res.data as WorkspaceDescriptorDto;
  authorizedWorkspaces.set(descriptor.workspaceId, descriptor);
  return descriptor;
}

/**
 * 启动桌面：先拉起 runtime 宿主，再创建窗口、登记 IPC、挂工作区选择通道。
 *
 * @returns 应用完成初始化后的 Promise。
 */
async function bootstrap(): Promise<void> {
  await app.whenReady();

  const windows = new WindowRegistry();
  runtimeHost = new RuntimeHost({
    createTransport: () => createUtilityTransport(DEFAULT_WORKER_ENTRY)
  });
  await runtimeHost.start();

  // 开发/托管启动可显式指定工作区根；自动授权仍走同一 runtime 登记路径（fail-closed）。
  const initialRoot = process.env.OHNA_WORKSPACE_ROOT?.trim();
  if (initialRoot) {
    await registerWorkspaceWithHost(deriveWorkspaceId(initialRoot), initialRoot);
  }

  unregisterIpc = registerIpc({ host: runtimeHost, windows });

  // 原生工作区授权：renderer 经 PICK_WORKSPACE_CHANNEL 请求主进程弹系统对话框并登记。
  ipcMain.handle(PICK_WORKSPACE_CHANNEL, async () =>
    pickWorkspace(mainWindow ?? null, (id, root) => registerWorkspaceWithHost(id, root))
  );
  // Git 分支只读：workspaceId 必须命中 runtime 授权表，未授权一律返回 null。
  ipcMain.handle(READ_GIT_BRANCH_CHANNEL, async (_event, input: { workspaceId?: unknown }) => {
    if (typeof input?.workspaceId !== "string") return null;
    const workspace = authorizedWorkspaces.get(input.workspaceId);
    return workspace ? readGitBranch(workspace.displayPath) : null;
  });
  // 用户级 settings：main 独占文件读写，renderer 只拿到结构化 JSON。
  const dataDir = process.env.OHNA_DATA_DIR || join(homedir(), ".ohna");
  ipcMain.handle(READ_SETTINGS_CHANNEL, async () => (await readSettings(dataDir)).settings);
  ipcMain.handle(SAVE_SETTINGS_CHANNEL, async (_event, input: unknown) => {
    const path = await writeSettings(dataDir, input as OhnaSettings);
    return { path };
  });
  ipcMain.handle(FETCH_PROVIDER_MODELS_CHANNEL, async (_event, input: {
    baseUrl?: unknown;
    apiKey?: unknown;
    httpProxy?: unknown;
  }) => {
    if (typeof input?.baseUrl !== "string" || typeof input.apiKey !== "string") {
      throw new Error("fetchModels 需要 baseUrl 与 apiKey");
    }
    const proxy = typeof input.httpProxy === "string" && input.httpProxy.trim()
      ? input.httpProxy.trim()
      : undefined;
    const fetchFn = createProxyAwareFetch(proxy ? { AIAGENT_HTTP_PROXY: proxy } : {});
    const response = await fetchFn(`${input.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` }
    });
    if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  });

  mainWindow = createMainWindow(windows);

  // 单实例：第二个实例聚焦已有窗口。
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("activate", () => {
    if (!mainWindow) mainWindow = createMainWindow(windows);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  unregisterIpc?.();
  void runtimeHost?.stop();
  runtimeHost = undefined;
});

// 单实例锁：失败则聚焦已有实例并退出（spec §8.1）。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}
