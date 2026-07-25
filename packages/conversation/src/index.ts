export type ConversationStatus = "active" | "archived";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  archivedAt?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  userId: string;
  runId?: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  clientMessageId?: string;
  sequence: number;
  createdAt: string;
  completedAt?: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface ListConversationsInput {
  status?: ConversationStatus;
  limit?: number;
  cursor?: string;
}

export interface CreateConversationInput {
  id?: string;
  title: string;
  now?: string;
}

export interface AppendMessageInput {
  id?: string;
  conversationId: string;
  runId?: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  clientMessageId?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface ListMessagesInput {
  conversationId: string;
  limit?: number;
  cursor?: string;
}

export type IdempotentMessageResult =
  | { outcome: "created"; message: Message }
  | { outcome: "existing"; message: Message };

export type ConversationRepositoryErrorCode =
  | "not_found"
  | "conflict"
  | "database_unavailable"
  | "invalid_cursor";

/**
 * 对话 repository 的结构化错误，原始 cause 只留在服务端诊断链路。
 */
export class ConversationRepositoryError extends Error {
  readonly code: ConversationRepositoryErrorCode;

  /**
   * @param code 稳定错误码。
   * @param message 可安全暴露给边界调用方的消息。
   * @param cause 不应序列化到 UI 的内部异常。
   */
  constructor(code: ConversationRepositoryErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConversationRepositoryError";
    this.code = code;
  }
}

export interface ConversationRepository {
  /** @param userId 所有者。 @param input 创建参数。 @returns 新会话。 */
  create(userId: string, input: CreateConversationInput): Promise<Conversation>;
  /** @param userId 当前用户。 @param input 分页参数。 @returns 会话页。 */
  list(userId: string, input?: ListConversationsInput): Promise<CursorPage<Conversation>>;
  /** @param userId 当前用户。 @param conversationId 会话 ID。 @returns 所属会话或 undefined。 */
  find(userId: string, conversationId: string): Promise<Conversation | undefined>;
  /** @param userId 当前用户。 @param conversationId 会话 ID。 @param title 新标题。 @param now 更新时间。 @returns 更新后会话。 */
  updateTitle(userId: string, conversationId: string, title: string, now?: string): Promise<Conversation>;
  /** @param userId 当前用户。 @param conversationId 会话 ID。 @param now 归档时间。 @returns 归档后会话。 */
  archive(userId: string, conversationId: string, now?: string): Promise<Conversation>;
}

export interface MessageRepository {
  /** @param userId 当前用户。 @param input 消息参数。 @returns 新消息。 */
  append(userId: string, input: AppendMessageInput): Promise<Message>;
  /** @param userId 当前用户。 @param input 幂等用户消息。 @returns 创建或已存在结果。 */
  appendUserMessageIdempotently(
    userId: string,
    input: AppendMessageInput & { role: "user"; clientMessageId: string }
  ): Promise<IdempotentMessageResult>;
  /** @param userId 当前用户。 @param input 分页参数。 @returns 消息页。 */
  list(userId: string, input: ListMessagesInput): Promise<CursorPage<Message>>;
  /** @param userId 当前用户。 @param messageId 消息 ID。 @returns 所属消息或 undefined。 */
  find(userId: string, messageId: string): Promise<Message | undefined>;
}
