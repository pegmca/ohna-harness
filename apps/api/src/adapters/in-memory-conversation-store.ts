import type {
  AppendStoredMessageInput,
  Conversation,
  ConversationRepository,
  CreateConversationInput,
  CursorPage,
  IdempotentStoredMessageResult,
  ListConversationsInput,
  ListStoredMessagesInput,
  MessageStore,
  StoredMessage
} from "@aiagent/conversation";
import { ConversationRepositoryError } from "@aiagent/conversation";

/**
 * 创建共享同一份内存事实源的 ConversationRepository + MessageStore（仅测试显式使用）。
 * 语义对齐 Postgres adapter：会话归属校验、sequence 单调分配、compaction 投影。
 *
 * @returns 内存会话与消息存储。
 */
export function createInMemoryConversationStores(): {
  conversationRepository: ConversationRepository;
  messageStore: MessageStore;
} {
  const conversations: Conversation[] = [];
  const messages: StoredMessage[] = [];

  /**
   * 解码内存分页游标（base64url 的非负整数偏移），无效游标与 Postgres adapter 一样抛 invalid_cursor。
   *
   * @param cursor 不透明游标。
   * @returns 偏移量。
   */
  function decodeOffset(cursor: string | undefined): number {
    if (!cursor) return 0;
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const offset = Number(raw);
    if (!Number.isInteger(offset) || offset < 0 || String(offset) !== raw) {
      throw new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.");
    }
    return offset;
  }

  const conversationRepository: ConversationRepository = {
    async create(userId: string, input: CreateConversationInput): Promise<Conversation> {
      const now = input.now ?? new Date().toISOString();
      const value: Conversation = {
        id: input.id ?? crypto.randomUUID(),
        userId,
        title: input.title,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now
      };
      conversations.push(value);
      return structuredClone(value);
    },
    async list(userId: string, input: ListConversationsInput = {}): Promise<CursorPage<Conversation>> {
      const offset = decodeOffset(input.cursor);
      const limit = input.limit ?? 50;
      const owned = conversations
        .filter((item) => item.userId === userId && item.status === (input.status ?? "active"))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id.localeCompare(a.id));
      const items = owned.slice(offset, offset + limit).map((item) => structuredClone(item));
      return {
        items,
        nextCursor: offset + limit < owned.length ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : undefined
      };
    },
    async find(userId: string, conversationId: string): Promise<Conversation | undefined> {
      const found = conversations.find((item) => item.id === conversationId && item.userId === userId);
      return found ? structuredClone(found) : undefined;
    },
    async updateTitle(userId: string, conversationId: string, title: string, now?: string): Promise<Conversation> {
      const found = conversations.find((item) => item.id === conversationId && item.userId === userId);
      if (!found) throw new ConversationRepositoryError("not_found", "Conversation resource was not found.");
      found.title = title;
      found.updatedAt = now ?? new Date().toISOString();
      return structuredClone(found);
    },
    async archive(userId: string, conversationId: string, now?: string): Promise<Conversation> {
      const found = conversations.find((item) => item.id === conversationId && item.userId === userId);
      if (!found) throw new ConversationRepositoryError("not_found", "Conversation resource was not found.");
      if (found.status !== "archived") {
        found.status = "archived";
        found.archivedAt = now ?? new Date().toISOString();
        found.updatedAt = found.archivedAt;
      }
      return structuredClone(found);
    }
  };

  /**
   * 在内存中分配下一条消息（含会话归属校验与 sequence 递增）。
   *
   * @param userId 当前用户。
   * @param input 消息输入。
   * @returns 新消息。
   */
  function appendMessage(userId: string, input: AppendStoredMessageInput): StoredMessage {
    const conversation = conversations.find((item) => item.id === input.conversationId && item.userId === userId);
    if (!conversation) throw new ConversationRepositoryError("not_found", "Conversation resource was not found.");
    const sequence = messages.filter((item) => item.conversationId === input.conversationId).length + 1;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const value: StoredMessage = {
      id: input.id ?? crypto.randomUUID(),
      conversationId: input.conversationId,
      userId,
      runId: input.runId,
      role: input.role,
      content: structuredClone(input.content),
      messageType: input.messageType ?? "normal",
      clientMessageId: input.clientMessageId,
      sequence,
      usage: input.usage,
      modelId: input.modelId,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage,
      createdAt
    };
    messages.push(value);
    conversation.lastMessageAt = createdAt > conversation.lastMessageAt ? createdAt : conversation.lastMessageAt;
    conversation.updatedAt = conversation.lastMessageAt;
    return structuredClone(value);
  }

  const messageStore: MessageStore = {
    async append(userId: string, input: AppendStoredMessageInput): Promise<StoredMessage> {
      return appendMessage(userId, input);
    },
    async appendUserMessageIdempotently(
      userId: string,
      input: AppendStoredMessageInput & { role: "user"; clientMessageId: string }
    ): Promise<IdempotentStoredMessageResult> {
      const existing = messages.find(
        (item) => item.userId === userId
          && item.conversationId === input.conversationId
          && item.clientMessageId === input.clientMessageId
      );
      if (existing) return { outcome: "existing", message: structuredClone(existing) };
      return { outcome: "created", message: appendMessage(userId, input) };
    },
    async list(userId: string, input: ListStoredMessagesInput): Promise<CursorPage<StoredMessage>> {
      const offset = decodeOffset(input.cursor);
      const limit = input.limit ?? 50;
      const owned = messages
        .filter((item) => item.userId === userId && item.conversationId === input.conversationId)
        .sort((a, b) => a.sequence - b.sequence);
      const items = owned.slice(offset, offset + limit).map((item) => structuredClone(item));
      return {
        items,
        nextCursor: offset + limit < owned.length ? Buffer.from(String(offset + limit), "utf8").toString("base64url") : undefined
      };
    },
    async listForContext(userId: string, conversationId: string): Promise<StoredMessage[]> {
      const owned = messages
        .filter((item) => item.userId === userId && item.conversationId === conversationId)
        .sort((a, b) => a.sequence - b.sequence);
      // 投影规则：最后一个 compaction + 其 sequence 之后的全部消息；无 compaction 返回全量。
      const lastCompaction = owned.reduce(
        (max, item) => (item.messageType === "compaction" ? Math.max(max, item.sequence) : max),
        0
      );
      return owned.filter((item) => item.sequence >= Math.max(lastCompaction, 1)).map((item) => structuredClone(item));
    }
  };

  return { conversationRepository, messageStore };
}
