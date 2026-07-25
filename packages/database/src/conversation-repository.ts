import type {
  AppendMessageInput,
  Conversation,
  ConversationRepository,
  CursorPage,
  IdempotentMessageResult,
  ListConversationsInput,
  ListMessagesInput,
  Message,
  MessageRepository
} from "@aiagent/conversation";
import { ConversationRepositoryError } from "@aiagent/conversation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isPostgresUniqueViolation, postgresTimestampToIso, withTransaction } from "./postgres.js";

export interface PostgresConversationRepositories {
  conversationRepository: ConversationRepository;
  messageRepository: MessageRepository;
}

/**
 * 创建共享同一连接池的 Conversation 与 Message PostgreSQL adapter。
 *
 * 两个 repository 共同依赖 conversation 行锁，确保消息幂等判断、sequence 分配与会话排序
 * 时间更新属于同一个事务边界。
 *
 * @param pool composition root 提供的 PostgreSQL 连接池。
 * @returns Conversation 与 Message repository。
 */
export function createPostgresConversationRepositories(pool: pg.Pool): PostgresConversationRepositories {
  return {
    conversationRepository: new PostgresConversationRepository(pool),
    messageRepository: new PostgresMessageRepository(pool)
  };
}

class PostgresConversationRepository implements ConversationRepository {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * 创建用户会话，初始排序时间与创建时间一致。
   *
   * @param userId 会话所有者。
   * @param input 标题、可选 ID 与时间。
   * @returns 新建会话。
   */
  async create(userId: string, input: { id?: string; title: string; now?: string }): Promise<Conversation> {
    const now = input.now ?? new Date().toISOString();
    try {
      const result = await this.pool.query<ConversationRow>(
        `insert into conversations(id,user_id,title,status,created_at,updated_at,last_message_at)
         values ($1,$2,$3,'active',$4,$4,$4)
         returning *`,
        [input.id ?? randomUUID(), userId, input.title, now]
      );
      return mapConversation(requireRow(result.rows[0]));
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 以 `(lastMessageAt,id)` 降序游标列出指定状态的用户会话。
   *
   * @param userId 当前用户。
   * @param input 状态、页大小和可选游标。
   * @returns 稳定游标页。
   */
  async list(userId: string, input: ListConversationsInput = {}): Promise<CursorPage<Conversation>> {
    const limit = normalizeLimit(input.limit);
    const cursor = input.cursor ? decodeConversationCursor(input.cursor) : undefined;
    try {
      const result = await this.pool.query<ConversationRow>(
        `select * from conversations
          where user_id=$1 and status=$2
            and ($3::timestamptz is null or (last_message_at,id) < ($3::timestamptz,$4::uuid))
          order by last_message_at desc,id desc
          limit $5`,
        [userId, input.status ?? "active", cursor?.lastMessageAt ?? null, cursor?.id ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(mapConversation);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor({ lastMessageAt: last.lastMessageAt, id: last.id }) : undefined
      };
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 按用户归属读取会话；其他用户的资源与不存在资源统一返回 undefined。
   *
   * @param userId 当前用户。
   * @param conversationId 会话 ID。
   * @returns 所属会话或 undefined。
   */
  async find(userId: string, conversationId: string): Promise<Conversation | undefined> {
    try {
      const result = await this.pool.query<ConversationRow>(
        "select * from conversations where id=$1 and user_id=$2",
        [conversationId, userId]
      );
      return result.rows[0] ? mapConversation(result.rows[0]) : undefined;
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 仅更新当前用户拥有的会话标题。
   *
   * @param userId 当前用户。
   * @param conversationId 会话 ID。
   * @param title 新标题。
   * @param now 更新时间。
   * @returns 更新后的会话。
   */
  async updateTitle(userId: string, conversationId: string, title: string, now = new Date().toISOString()): Promise<Conversation> {
    try {
      const result = await this.pool.query<ConversationRow>(
        "update conversations set title=$3,updated_at=$4 where id=$1 and user_id=$2 returning *",
        [conversationId, userId, title, now]
      );
      if (!result.rows[0]) throw notFound();
      return mapConversation(result.rows[0]);
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 幂等归档当前用户会话；重复调用保留首次归档时间。
   *
   * @param userId 当前用户。
   * @param conversationId 会话 ID。
   * @param now 首次归档时间。
   * @returns 已归档会话。
   */
  async archive(userId: string, conversationId: string, now = new Date().toISOString()): Promise<Conversation> {
    try {
      const result = await this.pool.query<ConversationRow>(
        `update conversations
            set status='archived',
                archived_at=coalesce(archived_at,$3),
                updated_at=case when status='archived' then updated_at else $3 end
          where id=$1 and user_id=$2
          returning *`,
        [conversationId, userId, now]
      );
      if (!result.rows[0]) throw notFound();
      return mapConversation(result.rows[0]);
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }
}

class PostgresMessageRepository implements MessageRepository {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * 在会话行锁保护下分配下一个 sequence 并追加消息。
   *
   * @param userId 当前用户。
   * @param input 消息内容与状态。
   * @returns 新消息。
   */
  async append(userId: string, input: AppendMessageInput): Promise<Message> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockOwnedConversation(client, userId, input.conversationId);
        return insertNextMessage(client, userId, input);
      });
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 在同一会话锁内检查 client ID，重复提交返回原消息而不新增 sequence。
   *
   * @param userId 当前用户。
   * @param input 带客户端幂等键的用户消息。
   * @returns created 或 existing 结果。
   */
  async appendUserMessageIdempotently(
    userId: string,
    input: AppendMessageInput & { role: "user"; clientMessageId: string }
  ): Promise<IdempotentMessageResult> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockOwnedConversation(client, userId, input.conversationId);
        const existing = await client.query<MessageRow>(
          `select * from messages
            where conversation_id=$1 and user_id=$2 and client_message_id=$3`,
          [input.conversationId, userId, input.clientMessageId]
        );
        if (existing.rows[0]) return { outcome: "existing", message: mapMessage(existing.rows[0]) };
        return { outcome: "created", message: await insertNextMessage(client, userId, input) };
      });
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 以 `(sequence,id)` 升序游标读取当前用户会话时间线。
   *
   * @param userId 当前用户。
   * @param input 会话、页大小和游标。
   * @returns 稳定消息页。
   */
  async list(userId: string, input: ListMessagesInput): Promise<CursorPage<Message>> {
    const limit = normalizeLimit(input.limit);
    const cursor = input.cursor ? decodeMessageCursor(input.cursor) : undefined;
    try {
      const result = await this.pool.query<MessageRow>(
        `select m.* from messages m
          join conversations c on c.id=m.conversation_id
         where m.conversation_id=$1 and m.user_id=$2 and c.user_id=$2
           and ($3::bigint is null or (m.sequence,m.id) > ($3::bigint,$4::uuid))
         order by m.sequence asc,m.id asc
         limit $5`,
        [input.conversationId, userId, cursor?.sequence ?? null, cursor?.id ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(mapMessage);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor({ sequence: last.sequence, id: last.id }) : undefined
      };
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }

  /**
   * 按消息与用户归属读取，避免先按 ID 查询后再补授权。
   *
   * @param userId 当前用户。
   * @param messageId 消息 ID。
   * @returns 所属消息或 undefined。
   */
  async find(userId: string, messageId: string): Promise<Message | undefined> {
    try {
      const result = await this.pool.query<MessageRow>(
        `select m.* from messages m
          join conversations c on c.id=m.conversation_id
         where m.id=$1 and m.user_id=$2 and c.user_id=$2`,
        [messageId, userId]
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : undefined;
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  status: "active" | "archived";
  created_at: Date | string;
  updated_at: Date | string;
  last_message_at: Date | string;
  archived_at: Date | string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  client_message_id: string | null;
  sequence: string | number;
  created_at: Date | string;
  completed_at: Date | string | null;
}

/**
 * 锁定属于当前用户的会话；归属校验直接进入 SQL，避免越权资源探测。
 *
 * @param client 当前事务连接。
 * @param userId 当前用户。
 * @param conversationId 会话 ID。
 * @returns 获得行锁后的 Promise。
 */
async function lockOwnedConversation(client: pg.PoolClient, userId: string, conversationId: string): Promise<void> {
  const result = await client.query(
    "select id from conversations where id=$1 and user_id=$2 for update",
    [conversationId, userId]
  );
  if (!result.rows[0]) throw notFound();
}

/**
 * 在已持有 conversation 行锁的事务中分配并写入消息。
 *
 * @param client 当前事务连接。
 * @param userId 消息所有者。
 * @param input 消息输入。
 * @returns 新消息。
 */
async function insertNextMessage(client: pg.PoolClient, userId: string, input: AppendMessageInput): Promise<Message> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const sequenceResult = await client.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)+1 as sequence from messages where conversation_id=$1",
    [input.conversationId]
  );
  const sequence = sequenceResult.rows[0]?.sequence ?? "1";
  const result = await client.query<MessageRow>(
    `insert into messages(
       id,conversation_id,user_id,run_id,role,content,status,client_message_id,sequence,created_at,completed_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.conversationId,
      userId,
      input.runId ?? null,
      input.role,
      input.content,
      input.status,
      input.clientMessageId ?? null,
      sequence,
      createdAt,
      input.completedAt ?? null
    ]
  );
  await client.query(
    `update conversations
        set last_message_at=greatest(last_message_at,$2::timestamptz),updated_at=greatest(updated_at,$2::timestamptz)
      where id=$1 and user_id=$3`,
    [input.conversationId, createdAt, userId]
  );
  return mapMessage(requireRow(result.rows[0]));
}

/** @param row PostgreSQL 会话行。 @returns 领域会话。 */
function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    createdAt: postgresTimestampToIso(row.created_at),
    updatedAt: postgresTimestampToIso(row.updated_at),
    lastMessageAt: postgresTimestampToIso(row.last_message_at),
    archivedAt: row.archived_at ? postgresTimestampToIso(row.archived_at) : undefined
  };
}

/** @param row PostgreSQL 消息行。 @returns 领域消息。 */
function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    role: row.role,
    content: row.content,
    status: row.status,
    clientMessageId: row.client_message_id ?? undefined,
    sequence: Number(row.sequence),
    createdAt: postgresTimestampToIso(row.created_at),
    completedAt: row.completed_at ? postgresTimestampToIso(row.completed_at) : undefined
  };
}

/** @param value 游标内容。 @returns 不透明 base64url 游标。 */
function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** @param cursor 不透明会话游标。 @returns 已校验的会话排序键。 */
function decodeConversationCursor(cursor: string): { lastMessageAt: string; id: string } {
  const value = decodeCursor(cursor);
  if (
    typeof value.lastMessageAt !== "string"
    || Number.isNaN(Date.parse(value.lastMessageAt))
    || typeof value.id !== "string"
    || !isUuid(value.id)
  ) {
    throw invalidCursor();
  }
  return { lastMessageAt: value.lastMessageAt, id: value.id };
}

/** @param cursor 不透明消息游标。 @returns 已校验的消息排序键。 */
function decodeMessageCursor(cursor: string): { sequence: number; id: string } {
  const value = decodeCursor(cursor);
  if (
    typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.id !== "string"
    || !isUuid(value.id)
  ) {
    throw invalidCursor();
  }
  return { sequence: value.sequence, id: value.id };
}

/** @param cursor base64url JSON 游标。 @returns 未知键值对象。 */
function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidCursor();
    return value as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof ConversationRepositoryError) throw cause;
    throw invalidCursor(cause);
  }
}

/** @param limit 调用方请求页大小。 @returns 1 至 100 的安全页大小。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidCursor();
  return limit;
}

/** @param value 待校验字符串。 @returns 是否为 PostgreSQL 可接受的 UUID 文本。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** @param row 预期存在的 RETURNING 行。 @returns 非空行。 */
function requireRow<T>(row: T | undefined): T {
  if (!row) throw new ConversationRepositoryError("database_unavailable", "Conversation persistence failed.");
  return row;
}

/** @returns 不泄漏资源归属的 not-found 错误。 */
function notFound(): ConversationRepositoryError {
  return new ConversationRepositoryError("not_found", "Conversation resource was not found.");
}

/** @param cause 可选解析错误。 @returns 安全的无效游标错误。 */
function invalidCursor(cause?: unknown): ConversationRepositoryError {
  return new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.", cause);
}

/** @param cause adapter 内部异常。 @returns 领域可识别的结构化错误。 */
function mapRepositoryError(cause: unknown): ConversationRepositoryError {
  if (cause instanceof ConversationRepositoryError) return cause;
  if (isPostgresUniqueViolation(cause)) {
    return new ConversationRepositoryError("conflict", "Conversation resource conflicts with existing data.", cause);
  }
  return new ConversationRepositoryError("database_unavailable", "Conversation persistence is unavailable.", cause);
}
