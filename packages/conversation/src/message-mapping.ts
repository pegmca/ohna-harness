/**
 * pi Message ↔ StoredMessage 映射层。
 *
 * 存在理由（架构规则 5）：packages/database 不得依赖 @aiagent/ai，消息表与 pi 类型
 * 同构但独立定义，因此双向映射集中在 packages/conversation。
 *
 * 映射规则：
 * - user：content 原样（string 或块数组）；
 * - assistant：content 块数组原样，usage/modelId/stopReason/errorMessage 提升到列；
 * - toolResult：整行投影为 {toolCallId, toolName, content, isError, details} envelope；
 * - compaction 行（message_type='compaction'，role='user'）：content 是已包裹的摘要文本，
 *   读回时直接作为 user 消息进入上下文（不再二次包裹）。
 */
import type { AssistantMessage, Message, ToolResultMessage, Usage, UserMessage } from "@aiagent/ai";
import type { AppendStoredMessageInput, StoredMessage } from "./index.js";

/** compaction 摘要文本的包裹前缀；与 agent 层 convertToLlm 的包裹格式保持一致。 */
export const COMPACTION_SUMMARY_PREFIX = "[以下是之前对话历史的压缩摘要]\n\n";

/**
 * 生成 compaction 落库的 content（已包裹的摘要文本，单文本形式）。
 *
 * @param summary 压缩摘要原文。
 * @returns 可直接写入 messages.content 的文本。
 */
export function compactionStoredContent(summary: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}${summary}`;
}

/**
 * 把一条 pi Message 转成落库输入（不含会话/Run 归属，由调用方补齐）。
 *
 * @param message loop 产出的终态消息（user/assistant/toolResult）。
 * @returns 落库输入的 role/content 与 assistant 扩展列。
 */
export function piMessageToAppendInput(
  message: Message
): Pick<AppendStoredMessageInput, "role" | "content" | "usage" | "modelId" | "stopReason" | "errorMessage"> {
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      usage: message.usage,
      modelId: message.model,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage
    };
  }
  return {
    role: "toolResult",
    content: {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      details: message.details
    }
  };
}

/**
 * 把存储消息读回为 pi Message（loop 上下文重建用）。
 * compaction 行投影为已包裹摘要文本的 user 消息（对齐 pi buildContextEntries 的投影语义）。
 *
 * @param stored 存储消息行。
 * @returns 可直接进入 AgentContext.messages 的 pi Message。
 */
export function storedMessageToPiMessage(stored: StoredMessage): Message {
  const timestamp = Date.parse(stored.createdAt);
  if (stored.messageType === "compaction") {
    const user: UserMessage = { role: "user", content: stored.content as string, timestamp };
    return user;
  }
  if (stored.role === "user") {
    const user: UserMessage = {
      role: "user",
      content: stored.content as UserMessage["content"],
      timestamp
    };
    return user;
  }
  if (stored.role === "assistant") {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: stored.content as AssistantMessage["content"],
      api: "openai-completions",
      provider: "mock",
      model: stored.modelId ?? "unknown",
      usage: stored.usage ?? zeroUsage(),
      stopReason: (stored.stopReason ?? "stop") as AssistantMessage["stopReason"],
      errorMessage: stored.errorMessage,
      timestamp
    };
    return assistant;
  }
  const envelope = stored.content as {
    toolCallId: string;
    toolName: string;
    content: ToolResultMessage["content"];
    isError: boolean;
    details?: unknown;
  };
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: envelope.toolCallId,
    toolName: envelope.toolName,
    content: envelope.content,
    isError: envelope.isError,
    details: envelope.details,
    timestamp
  };
  return toolResult;
}

/**
 * 批量把存储消息序列读回为 pi Message 序列（保持原顺序）。
 *
 * @param stored 存储消息序列（通常来自 listForContext）。
 * @returns pi Message 序列。
 */
export function storedMessagesToPiMessages(stored: StoredMessage[]): Message[] {
  return stored.map(storedMessageToPiMessage);
}

/** @returns 历史消息缺失 usage 时的兜底零值。 */
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
