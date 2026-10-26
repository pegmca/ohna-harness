import { contextBridge, ipcRenderer } from "electron";

type Ping = () => Promise<string>;

/**
 * 从主进程请求 utilityProcess 探活结果。
 *
 * @returns utilityProcess 返回的固定 `"pong"`。
 */
const ping: Ping = () => ipcRenderer.invoke("spike:ping");

contextBridge.exposeInMainWorld("spike", { ping });
