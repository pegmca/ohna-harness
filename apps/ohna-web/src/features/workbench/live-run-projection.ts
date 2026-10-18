import type { ApiError, RunStreamEventDtoV2 } from "@aiagent/types";
import { parseAssistantBlocks, parseToolResult } from "./format";
import type { UiContentBlock, UiToolCallBlock } from "./types";

export type LiveTerminalStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * live run 事件流的渲染投影：assistant 内容块 + 工具执行状态 + 终态。
 *
 * pi 协议里 message_update 的 partial 是「当前正在流式的那条消息」的累积，带工具调用的 run
 * 会产生多条 assistant 消息（工具调用消息 + 总结消息），因此投影按消息分段累积：
 * message_start/message_end 界定分段，message_update 只替换当前段，最终渲染时拼接所有段，
 * 避免中间消息的 text/toolCall 块被后续消息的 partial 整体覆盖（PR #16 review 问题 1）。
 */
export interface LiveRunProjection {
  blocks: UiContentBlock[];
  /** 当前活动的一句话描述，用于 live 过程摘要行。 */
  progressLabel: string;
  terminal: LiveTerminalStatus;
  error?: ApiError;
}

/** message_update payload 的窄形状（对齐 pi AssistantMessageEvent 协议）。 */
interface MessageUpdatePayload {
  assistantMessageEvent?: {
    type: string;
    partial?: { content?: unknown };
  };
}

/** message_start / message_end payload 的窄形状。 */
interface MessageBoundaryPayload {
  message?: { role?: string; content?: unknown };
}

/** tool_execution_* payload 的窄形状。 */
interface ToolExecutionPayload {
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

/** agent_end payload 的窄形状：携带本次 run 新产生的全部消息。 */
interface AgentEndPayload {
  messages?: Array<{ role?: string; content?: unknown }>;
  error?: { code?: string; message?: string };
}

type EventPayload = MessageUpdatePayload & MessageBoundaryPayload & ToolExecutionPayload & AgentEndPayload & {
  status?: string;
  message?: string;
  error?: ApiError;
};

/**
 * 把 canonical run_event 流投影为可渲染的 live 状态；允许包含续传 replay 的重复事件。
 *
 * @param events 按到达顺序收到的 envelope 列表。
 * @returns 当前渲染投影。
 */
export function projectLiveRun(events: RunStreamEventDtoV2[]): LiveRunProjection {
  let lastSequence = 0;
  // 每条 assistant 消息一个分段；渲染时按顺序拼接。
  let segments: UiContentBlock[][] = [];
  // message_end 后置位，下一条 message_update 即便缺 message_start 也开新段。
  let segmentClosed = false;
  let progressLabel = "正在准备回答";
  let terminal: LiveTerminalStatus = "running";
  let error: ApiError | undefined;

  for (const event of events) {
    if (event.sequence <= lastSequence) continue;
    lastSequence = event.sequence;
    const payload = (event.payload ?? {}) as EventPayload;

    switch (event.type) {
      case "message_start": {
        if (payload.message?.role === "assistant" || !payload.message?.role) {
          if (segments.length > 0 && !segmentClosed && segments[segments.length - 1].length === 0) break;
          segments.push([]);
          segmentClosed = false;
        }
        break;
      }
      case "message_update": {
        const partial = payload.assistantMessageEvent?.partial?.content;
        if (!partial) break;
        if (segments.length === 0 || segmentClosed) {
          segments.push([]);
          segmentClosed = false;
        }
        // partial 是该条消息的全量累积内容，只替换当前段；保留段内已配对工具状态。
        const current = segments[segments.length - 1];
        segments[segments.length - 1] = mergeToolState(current, parseAssistantBlocks(partial));
        const kind = payload.assistantMessageEvent?.type ?? "";
        progressLabel = kind.startsWith("thinking") ? "正在思考" : kind.startsWith("toolcall") ? "正在准备工具调用" : "正在生成回答";
        break;
      }
      case "message_end": {
        // message_end 携带该消息最终形态，用它收口当前段。
        const content = payload.message?.role === "assistant" ? payload.message.content : undefined;
        if (content) {
          if (segments.length === 0 || segmentClosed) segments.push([]);
          const current = segments[segments.length - 1];
          segments[segments.length - 1] = mergeToolState(current, parseAssistantBlocks(content));
        }
        segmentClosed = true;
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update": {
        progressLabel = `正在调用工具 ${payload.toolName ?? ""}`;
        updateTool(segments, payload.toolCallId, { status: "running" });
        break;
      }
      case "tool_execution_end": {
        progressLabel = `工具 ${payload.toolName ?? ""} 已返回`;
        updateTool(segments, payload.toolCallId, {
          status: payload.isError ? "failed" : "completed",
          result: payload.toolCallId && payload.toolName
            ? {
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                content: payload.result,
                isError: payload.isError === true
              }
            : undefined
        });
        break;
      }
      case "run_status": {
        if (payload.message) progressLabel = payload.message;
        if (payload.status === "cancelled" || payload.status === "interrupted") terminal = "cancelled";
        if (payload.status === "failed") terminal = "failed";
        if (payload.status === "completed") terminal = "completed";
        break;
      }
      case "run_error": {
        const runError = payload.error;
        terminal = runError?.code === "request_cancelled" ? "cancelled" : "failed";
        error = runError;
        progressLabel = runError?.message ?? "运行失败。";
        break;
      }
      case "agent_end": {
        if (payload.error) {
          terminal = "failed";
          error = {
            code: payload.error.code ?? "internal_error",
            message: payload.error.message ?? "Agent 运行失败。",
            requestId: event.requestId
          };
          progressLabel = error.message;
        } else {
          terminal = "completed";
          progressLabel = "回答完成";
        }
        // agent_end 携带 run 的全部新消息：拼接所有 assistant 分段并全局配对 toolResult。
        const finalSegments = segmentsFromFinalMessages(payload.messages);
        if (finalSegments) segments = finalSegments;
        break;
      }
      default:
        break;
    }
  }

  return { blocks: segments.flat(), progressLabel, terminal, error };
}

/**
 * 从 agent_end 的最终消息重建分段：每条 assistant 消息一段，toolResult 全局按 toolCallId 配对。
 *
 * @param messages run 新产生的消息列表。
 * @returns 最终分段；没有 assistant 消息时返回 undefined 保留流式中间态。
 */
function segmentsFromFinalMessages(
  messages: AgentEndPayload["messages"]
): UiContentBlock[][] | undefined {
  if (!messages) return undefined;
  const assistants = messages.filter((message) => message.role === "assistant");
  if (assistants.length === 0) return undefined;
  const segments = assistants.map((message) => parseAssistantBlocks(message.content));
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const result = parseToolResult(message.content);
    if (!result) continue;
    updateTool(segments, result.toolCallId, {
      status: result.isError ? "failed" : "completed",
      result
    });
  }
  return segments;
}

/**
 * partial 替换分段时保留旧块上已配对的工具状态（partial 内不含执行结果）。
 *
 * @param previous 之前的块列表。
 * @param next 最新 partial 解析出的块列表。
 * @returns 合并后的块列表。
 */
function mergeToolState(previous: UiContentBlock[], next: UiContentBlock[]): UiContentBlock[] {
  const stateById = new Map<string, UiToolCallBlock>();
  for (const block of previous) {
    if (block.type === "toolCall") stateById.set(block.id, block);
  }
  return next.map((block) => {
    if (block.type !== "toolCall") return block;
    const state = stateById.get(block.id);
    return state ? { ...block, status: state.status, result: state.result } : block;
  });
}

/**
 * 跨分段按 toolCallId 更新工具块状态；partial 尚未包含该块时静默跳过，后续 partial 出现时再合并。
 *
 * @param segments 全部分段。
 * @param toolCallId 工具调用 ID。
 * @param patch 状态补丁。
 * @returns 无返回值。
 */
function updateTool(
  segments: UiContentBlock[][],
  toolCallId: string | undefined,
  patch: { status?: UiToolCallBlock["status"]; result?: UiToolCallBlock["result"] }
): void {
  if (!toolCallId) return;
  for (const segment of segments) {
    const block = segment.find(
      (item): item is UiToolCallBlock => item.type === "toolCall" && item.id === toolCallId
    );
    if (!block) continue;
    if (patch.status) block.status = patch.status;
    if (patch.result) block.result = patch.result;
    return;
  }
}
