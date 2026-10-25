/**
 * Trace 页的事件投影：把 run-v2 事件流（含瞬态 message_update）压成可直接渲染的行。
 *
 * 为什么单独成文件：投影是纯函数，能独立单测；组件只负责展示，不重复推导状态。
 * 归并规则：
 * - `message_start` 开一条消息行，`message_update` 原地 patch（流式增长），`message_end` 定稿；
 * - `tool_execution_start/end` 按 toolCallId 合成一行（参数 + 结果 + 是否报错）；
 * - `llm_call` 独立成行（一等公民）；
 * - `run_status` / `run_error` 生成终态横条；
 * - `context_event` 独立成行（v2.0 上下文事件日志，供三面板联动定位）。
 *
 * agentId 归属（docs/v2.0/04 §5.1 / §2.3）：每行都带 `agentId`。取值优先来自事件 payload
 * （v2.0 的 `message_*` / `tool_execution_*` 随 agentLoop 发射并携带身份），其次来自
 * `llm_call.agentId`；两者都没有时归 supervisor 根节点——这是**归属语义**（扁平行归根），
 * 不是对缺失形状的降级分支。
 */
import type { LlmCallRecordDto, RunStreamEventDtoV2 } from "@aiagent/types";
import { SUPERVISOR_AGENT_ID } from "./trace-labels";

/** 助手/用户消息行。 */
export interface TraceMessageRow {
  kind: "message";
  key: string;
  /** 发起/承载该行的 agent（未打标归 supervisor 根节点）。 */
  agentId: string;
  role: string;
  text: string;
  /** true 表示仍在流式接收（message_end 尚未到达）。 */
  live: boolean;
}

/** 工具执行行。 */
export interface TraceToolRow {
  kind: "tool";
  key: string;
  /** 发起该工具调用的 agent。 */
  agentId: string;
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
  /** 发起该次调用的 agent（record.agentId 缺省归 supervisor）。 */
  agentId: string;
  record: LlmCallRecordDto;
}

/** 终态横条。 */
export interface TraceTerminalRow {
  kind: "terminal";
  key: string;
  /** 终态属于 run 本身，归 supervisor 根节点。 */
  agentId: string;
  status?: string;
  message?: string;
}

/** 上下文结构变化行（v2.0：compaction）。 */
export interface TraceContextRow {
  kind: "context";
  key: string;
  agentId: string;
  eventKind: string;
  /** 净增量（tokensAfter - tokensBefore，回收为负）。 */
  delta: number;
  before: number;
  after: number;
  detail?: string;
}

export type TraceRow =
  | TraceMessageRow
  | TraceToolRow
  | TraceLlmRow
  | TraceTerminalRow
  | TraceContextRow;

/** 行种类字符串联合（供测试与统计使用）。 */
export type TraceRowKind = TraceRow["kind"];

/** AgentEvent 的最小结构（web 侧不依赖 @aiagent/agent，只用事件字段）。 */
interface AgentEventLike {
  type?: string;
  /** v2.0 身份字段：AgentEvent 边界与消息事件均携带。 */
  agentId?: string;
  message?: { role?: string; content?: unknown };
  assistantMessageEvent?: { partial?: { role?: string; content?: unknown } };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** context_event payload。 */
  kind?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  detail?: string;
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
 * 解析一帧事件的 agentId 归属。
 *
 * 优先级：`payload.agentId` > `payload.record.agentId`（llm_call）> supervisor 根节点。
 * 空串与非法值同样归 supervisor，避免出现「无名 agent」这种不可点击的归属。
 *
 * @param payload 事件 payload（未知形状，由调用方保证已解包）。
 * @returns 归属的 agentId。
 */
export function resolveAgentId(payload: unknown): string {
  const typed = (payload ?? {}) as AgentEventLike;
  const fromPayload = typeof typed.agentId === "string" && typed.agentId !== "" ? typed.agentId : undefined;
  if (fromPayload) return fromPayload;
  return SUPERVISOR_AGENT_ID;
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
    // llm_call 的归属来自 record.agentId（采集层在 streamFn 入口读取 observer 写入）；
    // run_status / run_error 是 run 级终态，固定归 supervisor 根节点。
    const agentId =
      event.type === "llm_call"
        ? resolveAgentId(event.payload)
        : event.type === "run_status" || event.type === "run_error"
          ? SUPERVISOR_AGENT_ID
          : resolveAgentId(payload);
    switch (event.type) {
      case "message_start": {
        const text = textOfMessageContent(payload.message?.content);
        rows.push({
          kind: "message",
          key: `msg-${event.sequence}`,
          agentId,
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
            agentId,
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
            agentId,
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
          agentId,
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
          agentId,
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
          agentId,
          record,
        });
        break;
      }
      case "context_event": {
        const context = payload;
        const before = typeof context.tokensBefore === "number" ? context.tokensBefore : 0;
        const after = typeof context.tokensAfter === "number" ? context.tokensAfter : 0;
        rows.push({
          kind: "context",
          key: `context-${event.sequence}`,
          agentId,
          eventKind: context.kind ?? "context",
          delta: after - before,
          before,
          after,
          detail: typeof context.detail === "string" ? context.detail : undefined,
        });
        break;
      }
      case "run_status": {
        const statusPayload = event.payload as { status?: string; error?: { message?: string } } | null;
        rows.push({
          kind: "terminal",
          key: `status-${event.sequence}`,
          agentId,
          status: statusPayload?.status,
          // observe 型 run 的失败只有 run_status（没有 run_error），错误文案在这里（N2）。
          message: statusPayload?.error?.message,
        });
        break;
      }
      case "run_error": {
        const error = (event.payload as { error?: { message?: string } } | null)?.error;
        rows.push({
          kind: "terminal",
          key: `error-${event.sequence}`,
          agentId,
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
 * live 路径的增量归并在 `event-stream-merge.ts`，这里保留最朴素的不可变追加语义。
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