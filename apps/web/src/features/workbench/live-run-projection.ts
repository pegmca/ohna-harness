import type { ApiError, RunStreamEventDtoV2 } from "@aiagent/types";
import { parseAssistantBlocks, parseToolResult } from "./format";
import type { UiContentBlock, UiToolCallBlock } from "./types";

export type LiveTerminalStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * live run 事件流的渲染投影：assistant partial 内容块 + 工具执行状态 + 终态。
 * message_update 的 assistantMessageEvent 携带累积完整 partial，直接替换块列表即可，无需拼 delta。
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

/**
 * 把 canonical run_event 流投影为可渲染的 live 状态；允许包含续传 replay 的重复事件。
 *
 * @param events 按到达顺序收到的 envelope 列表。
 * @returns 当前渲染投影。
 */
export function projectLiveRun(events: RunStreamEventDtoV2[]): LiveRunProjection {
  let lastSequence = 0;
  let blocks: UiContentBlock[] = [];
  let progressLabel = "正在准备回答";
  let terminal: LiveTerminalStatus = "running";
  let error: ApiError | undefined;

  for (const event of events) {
    if (event.sequence <= lastSequence) continue;
    lastSequence = event.sequence;
    const payload = (event.payload ?? {}) as MessageUpdatePayload & ToolExecutionPayload & AgentEndPayload & {
      status?: string;
      message?: string;
      error?: ApiError;
    };

    switch (event.type) {
      case "message_update": {
        const partial = payload.assistantMessageEvent?.partial?.content;
        if (partial) {
          // partial 是全量累积内容，直接替换；保留已配对工具结果与执行状态。
          const next = parseAssistantBlocks(partial);
          blocks = mergeToolState(blocks, next);
          const kind = payload.assistantMessageEvent?.type ?? "";
          progressLabel = kind.startsWith("thinking") ? "正在思考" : kind.startsWith("toolcall") ? "正在准备工具调用" : "正在生成回答";
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update": {
        progressLabel = `正在调用工具 ${payload.toolName ?? ""}`;
        updateTool(blocks, payload.toolCallId, payload.toolName, { status: "running" });
        break;
      }
      case "tool_execution_end": {
        progressLabel = `工具 ${payload.toolName ?? ""} 已返回`;
        updateTool(blocks, payload.toolCallId, payload.toolName, {
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
        // agent_end 携带最终消息：用最后一条 assistant 内容收口，并配对 toolResult。
        const finalBlocks = blocksFromFinalMessages(payload.messages);
        if (finalBlocks) blocks = mergeToolState(blocks, finalBlocks);
        break;
      }
      default:
        break;
    }
  }

  return { blocks, progressLabel, terminal, error };
}

/**
 * 从 agent_end 的最终消息里提取 assistant 内容块并配对 toolResult。
 *
 * @param messages run 新产生的消息列表。
 * @returns 最终内容块；没有 assistant 消息时返回 undefined 保留流式中间态。
 */
function blocksFromFinalMessages(
  messages: AgentEndPayload["messages"]
): UiContentBlock[] | undefined {
  if (!messages) return undefined;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return undefined;
  const blocks = parseAssistantBlocks(lastAssistant.content);
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const result = parseToolResult(message.content);
    if (!result) continue;
    const block = blocks.find(
      (item): item is UiToolCallBlock => item.type === "toolCall" && item.id === result.toolCallId
    );
    if (block) {
      block.result = result;
      block.status = result.isError ? "failed" : "completed";
    }
  }
  return blocks;
}

/**
 * partial 替换块列表时保留旧块上已配对的工具状态（partial 内不含执行结果）。
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
 * 按 toolCallId 更新工具块状态；partial 尚未包含该块时静默跳过，后续 partial 出现时再合并。
 *
 * @param blocks 当前块列表。
 * @param toolCallId 工具调用 ID。
 * @param toolName 工具名。
 * @param patch 状态补丁。
 * @returns 无返回值。
 */
function updateTool(
  blocks: UiContentBlock[],
  toolCallId: string | undefined,
  toolName: string | undefined,
  patch: { status?: UiToolCallBlock["status"]; result?: UiToolCallBlock["result"] }
): void {
  if (!toolCallId) return;
  const block = blocks.find(
    (item): item is UiToolCallBlock => item.type === "toolCall" && item.id === toolCallId
  );
  if (!block) return;
  if (patch.status) block.status = patch.status;
  if (patch.result) block.result = patch.result;
}
