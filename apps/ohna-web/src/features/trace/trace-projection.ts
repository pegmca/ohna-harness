/**
 * Trace 页的事件投影：把 run-v2 事件流（含瞬态 message_update）压成可直接渲染的行。
 *
 * 为什么单独成文件：投影是纯函数，能独立单测；组件只负责展示，不重复推导状态。
 * 归并规则：
 * - `message_start` 开一条消息行，`message_update` 原地 patch（流式增长），`message_end` 定稿；
 * - `tool_execution_start/end` 按 toolCallId 合成一行（参数 + 结果 + 是否报错）；
 * - `llm_call` 独立成行（一等公民）；
 * - `run_status` / `run_error` 生成终态横条。
 */
import type { LlmCallRecordDto, RunStreamEventDtoV2 } from "@aiagent/types";

/** 助手/用户消息行。 */
export interface TraceMessageRow {
  kind: "message";
  key: string;
  role: string;
  text: string;
  /** true 表示仍在流式接收（message_end 尚未到达）。 */
  live: boolean;
}

/** 工具执行行。 */
export interface TraceToolRow {
  kind: "tool";
  key: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
}

/** LLM 采集行（一等公民，payload 即 LlmCallRecordDto）。 */
export interface TraceLlmRow {
  kind: "llm";
  key: string;
  record: LlmCallRecordDto;
}

/** 终态横条。 */
export interface TraceTerminalRow {
  kind: "terminal";
  key: string;
  status?: string;
  message?: string;
}

export type TraceRow = TraceMessageRow | TraceToolRow | TraceLlmRow | TraceTerminalRow;

/** AgentEvent 的最小结构（web 侧不依赖 @aiagent/agent，只用事件字段）。 */
interface AgentEventLike {
  type: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: { partial?: { role?: string; content?: unknown } };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

/**
 * 从消息 content 提取可读文本（text 块拼接；thinking 与 toolCall 不进正文）。
 *
 * @param content 消息内容（字符串或 content blocks）。
 * @returns 纯文本；无文本时返回空串。
 */
export function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const typed = block as { type?: string; text?: string };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * 把事件序列投影成渲染行。
 *
 * @param events 按 sequence 升序的 run 事件。
 * @returns 渲染行数组（保持事件顺序）。
 */
export function projectTraceRows(events: readonly RunStreamEventDtoV2[]): TraceRow[] {
  const rows: TraceRow[] = [];
  /** 当前正在流式接收的消息行索引。 */
  let openMessage: number | undefined;
  /** toolCallId → 工具行索引。 */
  const toolRows = new Map<string, number>();

  for (const event of events) {
    const payload = (event.payload ?? {}) as AgentEventLike;
    switch (event.type) {
      case "message_start": {
        const text = textOfMessageContent(payload.message?.content);
        rows.push({
          kind: "message",
          key: `msg-${event.sequence}`,
          role: payload.message?.role ?? "assistant",
          text,
          live: true,
        });
        openMessage = rows.length - 1;
        break;
      }
      case "message_update": {
        const partial = payload.assistantMessageEvent?.partial;
        const text = textOfMessageContent(partial?.content);
        if (openMessage !== undefined && rows[openMessage]?.kind === "message") {
          rows[openMessage] = { ...(rows[openMessage] as TraceMessageRow), text };
        } else if (text !== "") {
          rows.push({
            kind: "message",
            key: `msg-${event.sequence}`,
            role: partial?.role ?? "assistant",
            text,
            live: true,
          });
          openMessage = rows.length - 1;
        }
        break;
      }
      case "message_end": {
        const text = textOfMessageContent(payload.message?.content);
        if (openMessage !== undefined && rows[openMessage]?.kind === "message") {
          rows[openMessage] = {
            ...(rows[openMessage] as TraceMessageRow),
            text,
            live: false,
          };
          openMessage = undefined;
        } else {
          rows.push({
            kind: "message",
            key: `msg-${event.sequence}`,
            role: payload.message?.role ?? "assistant",
            text,
            live: false,
          });
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = payload.toolCallId ?? `tool-${event.sequence}`;
        toolRows.set(toolCallId, rows.length);
        rows.push({
          kind: "tool",
          key: `tool-${toolCallId}`,
          toolName: payload.toolName ?? "tool",
          args: payload.args,
          done: false,
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = payload.toolCallId ?? "";
        const index = toolRows.get(toolCallId);
        const finished: TraceToolRow = {
          kind: "tool",
          key: `tool-${toolCallId || event.sequence}`,
          toolName: payload.toolName ?? "tool",
          args: index !== undefined ? (rows[index] as TraceToolRow).args : payload.args,
          result: payload.result,
          isError: payload.isError === true,
          done: true,
        };
        if (index !== undefined) rows[index] = finished;
        else rows.push(finished);
        break;
      }
      case "llm_call": {
        // 坏行（payload:null / 旧版本记录）不能带崩整页：缺 request 就跳过（N1）。
        const record = event.payload as LlmCallRecordDto | null;
        if (!record || !record.request) break;
        rows.push({
          kind: "llm",
          key: `llm-${event.sequence}`,
          record,
        });
        break;
      }
      case "run_status": {
        const payload = event.payload as { status?: string; error?: { message?: string } } | null;
        rows.push({
          kind: "terminal",
          key: `status-${event.sequence}`,
          status: payload?.status,
          // observe 型 run 的失败只有 run_status（没有 run_error），错误文案在这里（N2）。
          message: payload?.error?.message,
        });
        break;
      }
      case "run_error": {
        const error = (event.payload as { error?: { message?: string } } | null)?.error;
        rows.push({
          kind: "terminal",
          key: `error-${event.sequence}`,
          status: "failed",
          message: error?.message,
        });
        break;
      }
      default:
        // agent_start / turn_* / 其它帧不单列：时间线只展示「说了什么、调了什么、LLM 花了多少」。
        break;
    }
  }

  return rows;
}

/**
 * 追加事件并重新投影（页面用：事件数组是不可变 state）。
 *
 * @param events 已有事件。
 * @param incoming 新到事件。
 * @returns 追加后的新数组。
 */
export function appendEvents(
  events: readonly RunStreamEventDtoV2[],
  incoming: RunStreamEventDtoV2
): RunStreamEventDtoV2[] {
  return [...events, incoming];
}
