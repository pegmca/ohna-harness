import type {
  AppendStoredMessageInput,
  CursorPage,
  IdempotentStoredMessageResult,
  ListStoredMessagesInput,
  MessageStore,
  StoredMessage
} from "@aiagent/conversation";
import { ConversationRepositoryError } from "@aiagent/conversation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isPostgresUniqueViolation, postgresTimestampToIso, withTransaction } from "./postgres.js";

/**
 * 创建线性消息（messages）的 PostgreSQL adapter。
 * 每方法映射一类 pi Message 的读写；不采用 pi 的 entry 树，投影退化为 sequence 过滤。
 *
 * @param pool composition root 提供的 PostgreSQL 连接池。
 * @returns MessageStore 端口实现。
 */
export function createPostgresMessageStore(pool: pg.Pool): MessageStore {
  return new PostgresMessageStore(pool);
}

class PostgresMessageStore implements MessageStore {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * 在会话行锁保护下分配下一个 sequence 并追加终态消息。
   *
   * @param userId 当前用户。
   * @param input 消息内容与归属。
   * @returns 新消息。
   */
  async append(userId: string, input: AppendStoredMessageInput): Promise<StoredMessage> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockOwnedConversation(client, userId, input.conversationId);
        return await insertNextMessage(client, userId, input);
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
    input: AppendStoredMessageInput & { role: "user"; clientMessageId: string }
  ): Promise<IdempotentStoredMessageResult> {
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
   * 以 `(sequence,id)` 升序游标读取当前用户会话时间线（UI 用，含 compaction 行原样返回）。
   *
   * @param userId 当前用户。
   * @param input 会话、页大小和游标。
   * @returns 稳定消息页。
   */
  async list(userId: string, input: ListStoredMessagesInput): Promise<CursorPage<StoredMessage>> {
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
   * LLM 上下文投影（agent loop 用）：最后一个 compaction 消息 + 其 sequence 之后的全部消息。
   * 线性模型下等价于 pi buildContextEntries，但无需 firstKeptEntryId 指针。
   *
   * @param userId 当前用户。
   * @param conversationId 会话 ID。
   * @returns 按 sequence 升序的投影消息序列。
   */
  async listForContext(userId: string, conversationId: string): Promise<StoredMessage[]> {
    try {
      const result = await this.pool.query<MessageRow>(
        `select * from messages
          where conversation_id=$1 and user_id=$2
            and sequence >= coalesce(
              (select max(sequence) from messages
                where conversation_id=$1 and message_type='compaction'),
              1)
          order by sequence asc`,
        [conversationId, userId]
      );
      return result.rows.map(mapMessage);
    } catch (cause) {
      throw mapRepositoryError(cause);
    }
  }
}

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  message_type: "normal" | "compaction";
  client_message_id: string | null;
  sequence: string | number;
  usage: StoredMessage["usage"] | null;
  model_id: string | null;
  stop_reason: string | null;
  error_message: string | null;
  created_at: Date | string;
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
  if (!result.rows[0]) {
    throw new ConversationRepositoryError("not_found", "Conversation resource was not found.");
  }
}

/**
 * 在已持有 conversation 行锁的事务中分配并写入消息，同时推进会话排序时间。
 *
 * @param client 当前事务连接。
 * @param userId 消息所有者。
 * @param input 消息输入。
 * @returns 新消息。
 */
async function insertNextMessage(
  client: pg.PoolClient,
  userId: string,
  input: AppendStoredMessageInput
): Promise<StoredMessage> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const sequenceResult = await client.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)+1 as sequence from messages where conversation_id=$1",
    [input.conversationId]
  );
  const sequence = sequenceResult.rows[0]?.sequence ?? "1";
  const result = await client.query<MessageRow>(
    `insert into messages(
       id,conversation_id,user_id,run_id,role,content,message_type,client_message_id,sequence,
       usage,model_id,stop_reason,error_message,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.conversationId,
      userId,
      input.runId ?? null,
      input.role,
      JSON.stringify(input.content),
      input.messageType ?? "normal",
      input.clientMessageId ?? null,
      sequence,
      input.usage ? JSON.stringify(input.usage) : null,
      input.modelId ?? null,
      input.stopReason ?? null,
      input.errorMessage ?? null,
      createdAt
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

/** @param row PostgreSQL 消息行。 @returns 领域存储消息。 */
function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    role: row.role,
    content: row.content,
    messageType: row.message_type,
    clientMessageId: row.client_message_id ?? undefined,
    sequence: Number(row.sequence),
    usage: row.usage ?? undefined,
    modelId: row.model_id ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: postgresTimestampToIso(row.created_at)
  };
}

/** @param value 游标内容。 @returns 不透明 base64url 游标。 */
function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** @param cursor 不透明消息游标。 @returns 已校验的消息排序键。 */
function decodeMessageCursor(cursor: string): { sequence: number; id: string } {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    value = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.", cause);
  }
  if (
    typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.id !== "string"
  ) {
    throw new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.");
  }
  return { sequence: value.sequence, id: value.id };
}

/** @param limit 调用方请求页大小。 @returns 1 至 100 的安全页大小。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.");
  }
  return limit;
}

/** @param row 预期存在的 RETURNING 行。 @returns 非空行。 */
function requireRow<T>(row: T | undefined): T {
  if (!row) throw new ConversationRepositoryError("database_unavailable", "Message persistence failed.");
  return row;
}

/** @param cause adapter 内部异常。 @returns 领域可识别的结构化错误。 */
function mapRepositoryError(cause: unknown): ConversationRepositoryError {
  if (cause instanceof ConversationRepositoryError) return cause;
  if (isPostgresUniqueViolation(cause)) {
    return new ConversationRepositoryError("conflict", "Message resource conflicts with existing data.", cause);
  }
  return new ConversationRepositoryError("database_unavailable", "Message persistence is unavailable.", cause);
}
