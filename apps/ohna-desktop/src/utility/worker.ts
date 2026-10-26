interface PingMessage {
  type: "ping";
  id: number;
}

interface PongMessage {
  type: "pong";
  id: number;
}

interface ReadyMessage {
  type: "ready";
}

/**
 * 返回工具链探活值。
 *
 * @returns 固定的 `"pong"`。
 */
export async function ping(): Promise<"pong"> {
  return "pong";
}

/**
 * 在 utilityProcess 中接收主进程移交的 MessagePort。
 *
 * utilityProcess 以独立 ESM 入口运行；parentPort 只负责握手，后续 runtime
 * 请求走独立 MessagePort，避免控制通道与业务流量耦合。
 *
 * @returns 无返回值。
 */
function listenForConnection(): void {
  process.parentPort.once("message", (event) => {
    const [port] = event.ports;
    if (!port) {
      return;
    }

    const ready: ReadyMessage = { type: "ready" };
    process.parentPort.postMessage(ready);
    listenForPing(port);
  });
}

/**
 * 在已移交的 MessagePort 上响应探活请求。
 *
 * @param port 主进程移交的通信端口。
 * @returns 无返回值。
 */
function listenForPing(port: Electron.MessagePortMain): void {
  port.on("message", (event) => {
    const request = event.data as PingMessage | undefined;
    if (request?.type !== "ping") {
      return;
    }

    const response: PongMessage = { type: "pong", id: request.id };
    port.postMessage(response);
  });
  port.start();
}

if (process.parentPort) {
  listenForConnection();
}
