import type {
  Conversation,
  ConversationRepository,
  CursorPage,
  ListConversationsInput
} from "@aiagent/conversation";
import { ConversationRepositoryError } from "@aiagent/conversation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isPostgresUniqueViolation, postgresTimestampToIso } from "./postgres.js";

/**
 * 创建会话主体（conversations_v2）的 PostgreSQL adapter。
 * 消息职责已由 message-repository.ts（messages_v2 线性模型）承接。
 *
 * @param pool composition root 提供的 PostgreSQL 连接池。
 * @returns Conversation repository。
 */
export function createPostgresConversationRepository(pool: pg.Pool): ConversationRepository {
  return new PostgresConversationRepository(pool);
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
        `insert into conversations_v2(id,user_id,title,status,created_at,updated_at,last_message_at)
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
      const result = await this.pool.query<ConversationListRow>(
        `select *,last_message_at::text as cursor_last_message_at from conversations_v2
          where user_id=$1 and status=$2
            and ($3::timestamptz is null or (last_message_at,id) < ($3::timestamptz,$4::uuid))
          order by last_message_at desc,id desc
          limit $5`,
        [userId, input.status ?? "active", cursor?.lastMessageAt ?? null, cursor?.id ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const pageRows = result.rows.slice(0, limit);
      const items = pageRows.map(mapConversation);
      const last = pageRows.at(-1);
      return {
        items,
        // cursor 必须使用数据库原始排序键；转成 JavaScript Date 会截断 timestamptz 的微秒。
        nextCursor: hasMore && last
          ? encodeCursor({ lastMessageAt: last.cursor_last_message_at, id: last.id })
          : undefined
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
        "select * from conversations_v2 where id=$1 and user_id=$2",
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
        "update conversations_v2 set title=$3,updated_at=$4 where id=$1 and user_id=$2 returning *",
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
        `update conversations_v2
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

interface ConversationListRow extends ConversationRow {
  cursor_last_message_at: string;
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
