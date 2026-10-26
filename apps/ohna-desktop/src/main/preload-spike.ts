import type { BrowserWindow } from "electron";

/**
 * 在真实 renderer 中调用 preload 暴露的探活方法。
 *
 * @param window 已完成页面加载的窗口。
 * @returns 无返回值，结果写入主进程日志供冷启动验收。
 */
export async function verifyPreloadSpike(window: BrowserWindow): Promise<void> {
  try {
    const result = await window.webContents.executeJavaScript(
      "window.spike.ping().then((result) => ({ hasSpike: true, result }))"
    );
    console.log("renderer bridge result", result);
  } catch (error) {
    console.error("renderer bridge failed", error);
  }
}
