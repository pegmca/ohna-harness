import { contextBridge, ipcRenderer } from "electron";
import { createOhnaSdk } from "./sdk.js";
import { EVENT_CHANNEL, type DeliveredEvent } from "./contract.js";

/**
 * 用真实渲染进程通道组装语义化 SDK。
 *
 * 仅经 contextBridge 暴露语义方法：不暴露 `ipcRenderer` / `invoke` / 任意 Node 模块 /
 * 绝对路径写入接口（spec §5.1 / §9 安全基线）。事件订阅走独立 `ohna:event` 推送通道，
 * 由 SDK 内部按 subscriptionId 过滤后回调渲染端。worker 的 `ping` 探活已不再经 SDK 暴露。
 */
const sdk = createOhnaSdk(
  (channel, envelope) => ipcRenderer.invoke(channel, envelope),
  (channel, listener) => {
    const handler = (_event: unknown, payload: DeliveredEvent) => listener(undefined, payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
);

contextBridge.exposeInMainWorld("ohna", sdk);
