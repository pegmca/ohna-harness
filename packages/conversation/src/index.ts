/**
 * 会话领域类型与存储端口（阶段 3 线性模型重写）。
 *
 * 结构：
 * - Conversation / ConversationRepository：会话主体 CRUD（表 conversations_v2）；
 * - StoredMessage / MessageStore：线性消息存储端口（表 messages_v2），
 *   每方法映射一类 pi Message 的读写，不采用 pi 的 entry 树；
 * - message-mapping.ts：pi Message ↔ StoredMessage 的双向映射层。
 *   packages/database 不得依赖 @aiagent/ai（架构规则 5），映射因此放在本包。
 */
export type ConversationStatus = "active" | "archived";

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

/** 消息与私有 RAG 文档的稳定绑定快照（附件沿用旧表，阶段 5 回迁到新消息）。 */
export interface MessageAttachment {
  id: string;
  documentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  ordinal: number;
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

/** 线性消息角色，对齐 pi Message 三元组。 */
export type StoredMessageRole = "user" | "assistant" | "toolResult";

/** 消息类型：compaction 摘要消息在上下文投影中顶替其前历史。 */
export type StoredMessageType = "normal" | "compaction";

/**
 * 存储消息记录：数据库行到 pi Message 的一对一投影。
 * content 为 pi content 原样 JSON（user 为 string 或块数组，assistant 为块数组，
 * toolResult 为 toolCallId/toolName/content/isError envelope），读回即可直接喂 convertToLlm。
 */
export interface StoredMessage {
  id: string;
  conversationId: string;
  userId: string;
  runId?: string;
  role: StoredMessageRole;
  content: unknown;
  messageType: StoredMessageType;
  clientMessageId?: string;
  sequence: number;
  /** 仅 assistant：pi Usage 形状。 */
  usage?: import("@aiagent/ai").Usage;
  /** 仅 assistant：模型目录标识。 */
  modelId?: string;
  /** 仅 assistant：停止原因。 */
  stopReason?: string;
  /** 仅 assistant：error/aborted 时的脱敏错误说明。 */
  errorMessage?: string;
  createdAt: string;
}

/** 追加一条终态消息的输入；sequence 由存储在会话行锁内分配。 */
export interface AppendStoredMessageInput {
  id?: string;
  conversationId: string;
  runId?: string;
  role: StoredMessageRole;
  content: unknown;
  messageType?: StoredMessageType;
  clientMessageId?: string;
  usage?: import("@aiagent/ai").Usage;
  modelId?: string;
  stopReason?: string;
  errorMessage?: string;
  createdAt?: string;
}

export interface ListStoredMessagesInput {
  conversationId: string;
  limit?: number;
  cursor?: string;
}

export type IdempotentStoredMessageResult =
  | { outcome: "created"; message: StoredMessage }
  | { outcome: "existing"; message: StoredMessage };

/**
 * 消息存储端口：线性 append + 投影读取（对齐 docs/worktree/05 的 MessageStore 草案）。
 */
export interface MessageStore {
  /** @param userId 当前用户。 @param input 终态消息。 @returns 已分配 sequence 的存储消息。 */
  append(userId: string, input: AppendStoredMessageInput): Promise<StoredMessage>;
  /**
   * 以 client_message_id 幂等写入用户消息；冲突时返回既有行（outcome="existing"）。
   *
   * @param userId 当前用户。
   * @param input 带客户端幂等键的用户消息。
   * @returns 创建或已存在结果。
   */
  appendUserMessageIdempotently(
    userId: string,
    input: AppendStoredMessageInput & { role: "user"; clientMessageId: string }
  ): Promise<IdempotentStoredMessageResult>;
  /** @param userId 当前用户。 @param input 会话与游标分页参数。 @returns 时间线页（含 compaction 行原样返回）。 */
  list(userId: string, input: ListStoredMessagesInput): Promise<CursorPage<StoredMessage>>;
  /**
   * LLM 上下文投影（agent loop 用）：取会话内最后一个 compaction 消息 +
   * 其 sequence 之后的全部消息；无 compaction 时返回全量。按 sequence 升序。
   *
   * @param userId 当前用户。
   * @param conversationId 会话 ID。
   * @returns 可直接转 pi Message[] 的存储消息序列。
   */
  listForContext(userId: string, conversationId: string): Promise<StoredMessage[]>;
}

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

export {
  COMPACTION_SUMMARY_PREFIX,
  compactionStoredContent,
  piMessageToAppendInput,
  storedMessageToPiMessage,
  storedMessagesToPiMessages
} from "./message-mapping.js";
