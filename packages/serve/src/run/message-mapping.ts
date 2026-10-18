/**
 * 本地线性消息 ↔ AgentMessage 的映射。
 *
 * 从 `run-manager.ts` 拆出，保持「消息形状转换」与「run 生命周期编排」两个关注点分离；
 * toolResult 的 content 是 envelope，形状与 `packages/conversation` 的落库映射一致。
 */
import type { AgentMessage, CompactionMessage } from "@aiagent/agent";
import type { AssistantMessage, Model, StopReason, Usage, UserMessage } from "@aiagent/ai";
import type { LinearMessageDto } from "@aiagent/types";

/**
 * 把线性消息 DTO 还原为 `agentLoop` 可消费的 AgentMessage。
 *
 * compaction 行还原为内核的 CompactionMessage（而非 user 消息）：这样
 * `prepareCompaction` 能把已落盘摘要识别为 previousSummary 供迭代更新，
 * `convertToLlm` 在发给模型前把它转成 user 消息（pi 的 buildSessionContext 心智）。
 *
 * @param dto 已落盘消息。
 * @param model 当前模型（补齐 assistant 的 api/provider）。
 * @returns AgentMessage；无法还原时返回 null。
 */
export function linearMessageToAgentMessage(
  dto: LinearMessageDto,
  model: Model<"openai-completions">
): AgentMessage | null {
  const timestamp = Date.parse(dto.createdAt);
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();

  if (dto.messageType === "compaction") {
    const compaction: CompactionMessage = {
      role: "compaction",
      summary: typeof dto.content === "string" ? dto.content : "",
      tokensBefore: 0,
      summarizedMessageCount: 0,
      timestamp: safeTimestamp
    };
    return compaction;
  }

  if (dto.role === "user") {
    const user: UserMessage = {
      role: "user",
      content: dto.content as UserMessage["content"],
      timestamp: safeTimestamp
    };
    return user;
  }

  if (dto.role === "assistant") {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: dto.content as AssistantMessage["content"],
      api: model.api,
      provider: model.provider,
      model: dto.modelId ?? model.id,
      usage: (dto.usage as Usage | undefined) ?? zeroUsage(),
      stopReason: (dto.stopReason as StopReason | undefined) ?? "stop",
      timestamp: safeTimestamp
    };
    return assistant;
  }

  const envelope = dto.content as {
    toolCallId?: unknown;
    toolName?: unknown;
    content?: unknown;
    isError?: unknown;
    details?: unknown;
  } | null;
  if (!envelope || typeof envelope.toolCallId !== "string" || !Array.isArray(envelope.content)) {
    return null;
  }
  return {
    role: "toolResult",
    toolCallId: envelope.toolCallId,
    toolName: typeof envelope.toolName === "string" ? envelope.toolName : "unknown",
    content: envelope.content as { type: "text"; text: string }[],
    isError: Boolean(envelope.isError),
    details: envelope.details,
    timestamp: safeTimestamp
  };
}

/**
 * 历史 assistant 消息缺失 usage 时的零值。
 *
 * @returns 零 usage。
 */
export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
