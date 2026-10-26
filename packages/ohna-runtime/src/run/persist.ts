/**
 * 线性消息持久化：把 `agentLoop` 的 message_end 写进会话 JSONL。
 *
 * 单独成文件的原因：这里的过滤规则（跳过 compaction / 首次 prompt / 失败半成品）
 * 属于「会话历史语义」，与 run 事件状态机是两件事。
 */
import type { AgentMessage } from "@aiagent/agent";
import type { LocalMessageStore, LocalSessionStore } from "../store/index.js";
import type { ActiveRun } from "./types.js";

/** 持久化所需的 store 端口。 */
export interface MessagePersistStores {
  messageStore: LocalMessageStore;
  sessionStore: LocalSessionStore;
}

/**
 * 持久化 message_end 对应的线性消息；prompt 的首次 user 消息已由 createRun 落库。
 *
 * @param stores 会话消息 / 会话元数据 store。
 * @param run 活跃 run。
 * @param message loop 消息。
 */
export async function persistRunMessage(
  stores: MessagePersistStores,
  run: ActiveRun,
  message: AgentMessage
): Promise<void> {
  if (message.role === "compaction") return;
  if (message.role === "user" && run.skipFirstUserMessage) {
    run.skipFirstUserMessage = false;
    return;
  }

  if (message.role === "user") {
    await stores.messageStore.append(run.snapshot.conversationId, {
      role: "user",
      content: message.content,
      runId: run.snapshot.runId
    });
  } else if (message.role === "assistant") {
    // 失败/中断的 assistant 是半成品，不进入会话历史（与 CLI 的落盘过滤一致），
    // 否则下一轮会把一段被截断的思考当成已完成上下文。
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    await stores.messageStore.append(run.snapshot.conversationId, {
      role: "assistant",
      content: message.content,
      usage: message.usage,
      modelId: message.model,
      stopReason: message.stopReason,
      runId: run.snapshot.runId
    });
  } else {
    await stores.messageStore.append(run.snapshot.conversationId, {
      role: "toolResult",
      content: {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
        details: message.details
      },
      runId: run.snapshot.runId
    });
  }
  await stores.sessionStore.touch(run.snapshot.conversationId);
}
