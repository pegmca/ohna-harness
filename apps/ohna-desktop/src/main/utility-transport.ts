/**
 * 生产用 `RuntimeHostTransport`：基于 `utilityProcess.fork` + 移交的 `MessagePortMain`。
 *
 * 这是 Task 1 spike 的正式化：主进程 fork 出承载 `OhnaRuntime` 的 worker，先用 `parentPort`
 * 完成握手，再把独立 `MessagePort` 交给 worker 走业务流量（控制通道与业务流量解耦，spec §1.1）。
 * worker 崩溃时透传退出码 / 信号给宿主做退避重启。
 */
import { join } from "node:path";
import { utilityProcess, MessageChannelMain } from "electron";
import type { RuntimeEventEnvelope, RuntimeRequestEnvelope, RuntimeResponseEnvelope } from "@aiagent/types";
import type { CrashInfo, RuntimeHostTransport } from "./runtime-host.js";

/** 握手/控制消息形状（仅用于 parentPort，不进业务信封）。 */
type ControlMessage =
  | { type: "ready" }
  | { type: "response"; envelope: RuntimeResponseEnvelope }
  | { type: "event"; envelope: RuntimeEventEnvelope };

/**
 * 构造一份 utilityProcess 传输。
 *
 * @param workerEntry worker 入口脚本的绝对路径（构建产物 `dist/utility/worker.js`）。
 * @param handshakeTimeoutMs 握手超时毫秒，默认 5000。
 * @returns 传输实例。
 */
export function createUtilityTransport(
  workerEntry: string,
  handshakeTimeoutMs = 5_000
): RuntimeHostTransport {
  let child: Electron.UtilityProcess | undefined;
  let port: Electron.MessagePortMain | undefined;
  let responseCb: ((envelope: RuntimeResponseEnvelope) => void) | undefined;
  let eventCb: ((envelope: RuntimeEventEnvelope) => void) | undefined;
  let crashCb: ((info: CrashInfo) => void) | undefined;
  let handshakeResolve: (() => void) | undefined;

  return {
    async start() {
      const channel = new MessageChannelMain();
      child = utilityProcess.fork(workerEntry, [], {
        serviceName: "ohna-desktop-runtime",
        // sandbox: true 下 preload 不加载，但 worker 仍是 Node，需允许其加载 runtime 依赖。
        env: { ...process.env }
      });

      const ready = new Promise<void>((resolve, reject) => {
        handshakeResolve = resolve;
        const timer = setTimeout(
          () => reject(new Error("utilityProcess 握手超时")),
          handshakeTimeoutMs
        );
        // Electron 的 UtilityProcess 事件重载未声明 "exit"（仅 "spawn"），需经 unknown 中转绑定；
        // 退出码/信号显式标注，避免隐式 any。
        const onceExit = (child as unknown as {
          once: (event: string, cb: (code: number | null, signal: string | null) => void) => void;
        }).once;
        onceExit("exit", (code, signal) => {
          clearTimeout(timer);
          crashCb?.({ code, signal: signal ?? null });
        });
        child!.once("message", (message) => {
          const msg = message as ControlMessage | undefined;
          if (msg?.type !== "ready") return;
          clearTimeout(timer);
          resolve();
        });
      });

      child.once("spawn", () => {
        child!.postMessage({ type: "connect" }, [channel.port1]);
      });

      await ready;
      port = channel.port2;
      port.on("message", (event) => {
        const msg = event.data as ControlMessage | undefined;
        if (msg?.type === "response") responseCb?.(msg.envelope);
        else if (msg?.type === "event") eventCb?.(msg.envelope);
      });
      port.start();
    },
    postRequest(envelope: RuntimeRequestEnvelope) {
      port?.postMessage({ type: "request", envelope });
    },
    onResponse(cb) {
      responseCb = cb;
    },
    onEvent(cb) {
      eventCb = cb;
    },
    onCrash(cb) {
      crashCb = cb;
    },
    async stop() {
      handshakeResolve = undefined;
      port?.close();
      port = undefined;
      child?.kill();
      child = undefined;
    }
  };
}

/** 供 main/index.ts 复用：默认 worker 入口路径。 */
export const DEFAULT_WORKER_ENTRY = join(import.meta.dirname, "../utility/worker.js");
