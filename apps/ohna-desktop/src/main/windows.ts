/**
 * 安全窗口工厂与窗口归属登记（spec §9）。
 *
 * 维护 `webContents.id → 身份` 的单例映射：所有 IPC handler 在响应前都要校验 sender 是否属于
 * 本应用窗口，拒绝未知 / 已销毁窗口（spec §9 sender 校验）。窗口销毁时清理映射与订阅。
 */
import { join } from "node:path";
import { BrowserWindow, type WebContents } from "electron";

/** 已登记窗口的身份信息（当前仅持有者标记，可扩展为作用域）。 */
export interface WindowIdentity {
  id: number;
}

/**
 * 窗口归属登记器：单例持有 `webContents.id → 身份`，并提供校验 / 清理能力。
 */
export class WindowRegistry {
  private readonly map = new Map<number, WindowIdentity>();

  /**
   * 登记一个窗口的 webContents.id。
   *
   * @param id webContents.id。
   * @returns 无返回值。
   */
  register(id: number): void {
    this.map.set(id, { id });
  }

  /**
   * 校验某 webContents 是否为已授权窗口。
   *
   * @param webContents 待校验的 webContents。
   * @returns 已登记返回 true。
   */
  isKnown(webContents: WebContents): boolean {
    return this.map.has(webContents.id);
  }

  /**
   * 按 webContents.id 注销窗口（销毁时调用）。
   *
   * @param id webContents.id。
   * @returns 无返回值。
   */
  unregister(id: number): void {
    this.map.delete(id);
  }

  /**
   * 返回当前已登记窗口数（测试 / 诊断用）。
   *
   * @returns 窗口数。
   */
  size(): number {
    return this.map.size;
  }
}

/** 默认渲染入口（HTML），由 electron-vite 构建到 dist/renderer。 */
const RENDERER_HTML = join(import.meta.dirname, "../renderer/index.html");

/** 默认 preload 脚本（CJS），由 electron-vite 构建到 dist/preload。 */
const PRELOAD = join(import.meta.dirname, "../preload/index.cjs");

/**
 * 创建符合安全基线的 BrowserWindow（spec §9）。
 *
 * - nodeIntegration:false / contextIsolation:true / sandbox:true / webSecurity:true；
 * - 拒绝新窗口打开（setWindowOpenHandler deny），外部链接交系统浏览器；
 * - will-navigate 阻止离开应用页面；
 * - 不加载远程页面，仅加载本地打包产物。
 *
 * @param options 可选尺寸 / 显隐覆盖。
 * @returns 已装配的窗口（尚未 loadURL）。
 */
export function createSecureWindow(options: { width?: number; height?: number; show?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    // 默认窗口按常见 13/14 寸屏幕给足对话与 Trace 空间；最小尺寸防止侧栏被挤到不可用。
    width: options.width ?? 1440,
    height: options.height ?? 900,
    minWidth: 960,
    minHeight: 640,
    show: options.show ?? false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 不允许 renderer 自行选择任意目录（spec §6.1）；工作区授权只走原生对话框。
      additionalArguments: []
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  return window;
}

/**
 * 加载渲染入口并在首帧时显示窗口。
 *
 * @param window 已创建的窗口。
 * @returns 加载完成的 Promise（ready-to-show 后 resolve）。
 */
export function loadSecureWindow(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    window.once("ready-to-show", () => {
      window.show();
      resolve();
    });
    // electron-vite dev 会注入 ELECTRON_RENDERER_URL；开发期必须加载 dev server，
    // 否则 window 读的是旧 dist 产物，源码热更新与新增 UI 都不会出现在窗口里。
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    void (devUrl ? window.loadURL(devUrl) : window.loadFile(RENDERER_HTML));
  });
}
