/**
 * 共享渲染与常量（docs/v1.4/06 单一形态复用）。
 *
 * 旧版 `ohna --web` 的进程内托管 readline 循环已退役：单一形态下，默认 REPL（repl.ts）
 * 与浏览器都是进程内 serve 的执行线订阅者，走同一条 `server.createRun` +
 * `server.subscribeConversation` 事件流。本文件只保留终端与浏览器可复用的渲染逻辑：
 * `renderFrame` 把 run-v2 帧渲染进终端（AgentEvent 帧交给 renderEvent；run_status /
 * user_message / confirmation_requested 由调用方配合处理）。
 */
import type { AgentEvent } from "@aiagent/agent";
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { renderEvent, type RenderOptions } from "../ui/render.js";
import { CROSS, paint, STOP, supportsAnsi } from "../ui/theme.js";

/** 可渲染为 AgentEvent 的 run-v2 帧类型（payload 即 AgentEvent JSON）。 */
export const AGENT_EVENT_FRAME_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_end",
]);

/** run-v2 的终态 run_status 取值（与 run-stream-client 的 TERMINAL_STATUSES 一致）。 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * 渲染单帧 run-v2 事件：AgentEvent 帧交给 renderEvent（流式 delta / 工具 / diff / 折叠），
 * run_status 终态触发在途 run 的收尾回调，其余控制帧（user_message / confirmation_requested）
 * 由调用方在订阅回调里先行处理。
 *
 * @param event run-v2 帧。
 * @param tracker 会话级用量累计器。
 * @param options 渲染选项。
 * @param activeRun 在途 run（匹配 runId 时终态收尾）。
 * @param onFinish 终态回调。
 * @param tui 可选整屏 TUI（user_message 走语义条目而非直写）。
 */
export function renderFrame(
  event: RunStreamEventDtoV2,
  tracker: { snapshot(): { total: number; cost: number } },
  options: RenderOptions,
  activeRun: { runId: string } | null,
  onFinish: () => void,
  tui?: { appendUser(text: string): void },
): void {
  if (event.type === "run_status") {
    if (activeRun && event.runId === activeRun.runId) onFinish();
    const status = (event.payload as { status?: string } | null)?.status;
    if (status === "interrupted") process.stdout.write("\n" + paint(`${STOP} run 已中断。`, "dim") + "\n");
    if (status === "failed") process.stdout.write("\n" + paint(`${CROSS} run 失败。`, "error") + "\n");
    return;
  }
  if (event.type === "run_error") {
    const error = (event.payload as { error?: { message?: string } } | null)?.error;
    process.stdout.write("\n" + paint(`${CROSS} run 错误：${error?.message ?? "未知错误"}`, "error") + "\n");
    return;
  }
  // U1/D-A2：user_message 帧来自 serve 落盘的用户气泡权威来源。
  // - source==="web"：浏览器 composer 发起，终端订阅同一会话时必须显示（避免「只渲染本地、Web 端不显示」）。
  // - source==="cli"：本终端自己发起的输入，本地已回显（echoSubmitted），跳过以免双打印。
  if (event.type === "user_message") {
    const payload = event.payload as { source?: string; content?: string };
    if (payload.source === "cli") return;
    if (payload.content !== undefined) {
      if (tui) tui.appendUser(payload.content);
      else process.stdout.write(`${payload.content}\n`);
    }
    return;
  }
  // 确认事件 / MCP discovery 事件由浏览器与日志侧消费，终端不重复渲染。
  if (!AGENT_EVENT_FRAME_TYPES.has(event.type)) return;
  renderEvent(event.payload as AgentEvent, tracker as never, options);
}

/** 终端是否支持 ANSI 颜色（供调用方选择渲染路径）。 */
export const isAnsiSupported = supportsAnsi;
