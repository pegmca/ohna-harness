import type { AgentRunEventInputDto, AgentRunSnapshotDto, AgentRunStatusDto, AgentRunStreamEventDto, ApiError, CitationDto } from "@aiagent/types";
import type { NewCitationInput } from "@aiagent/rag";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { insertMessageCitations } from "./citation-repository.js";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

const TERMINAL = new Set<AgentRunStatusDto>(["succeeded", "failed", "cancelled"]);

export interface CreateRunInput {
  runId: string; requestId: string; userId: string; conversationId: string;
  message: string; clientMessageId: string; mode: "auto" | "report";
  source: "composer" | "report_button"; modelId: string; attachmentDocumentIds: string[];
  traceId: string; createdAt: string;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<{ snapshot: AgentRunSnapshotDto; created: boolean }>;
  findById(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  listAttachmentDocumentIds(userId: string, runId: string): Promise<string[] | undefined>;
  append(userId: string, runId: string, event: AgentRunEventInputDto): Promise<AgentRunStreamEventDto | undefined>;
  listEvents(userId: string, runId: string, afterSequence: number): Promise<AgentRunStreamEventDto[] | undefined>;
  recoverStale(before: string, occurredAt: string): Promise<AgentRunStreamEventDto[]>;
}

/**
 * 创建 Run PostgreSQL adapter；行锁同时保护 sequence 分配、投影更新与终态 CAS。
 *
 * @param pool PostgreSQL 连接池。
 * @returns Run repository。
 */
export function createPostgresRunRepository(pool: pg.Pool): RunRepository {
  return new PostgresRunRepository(pool);
}

class PostgresRunRepository implements RunRepository {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /** @param input Run、消息和幂等信息。 @returns 新建或已存在的 Run。 */
  async create(input: CreateRunInput): Promise<{ snapshot: AgentRunSnapshotDto; created: boolean }> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const conversation = await client.query(
          "select id from conversations where id=$1 and user_id=$2 for update",
          [input.conversationId, input.userId]
        );
        if (!conversation.rowCount) throw new RepositoryError("not_found", "Conversation not found.");
        const existing = await client.query<RunRow>(
          "select * from agent_runs where request_id=$1 and user_id=$2",
          [input.requestId, input.userId]
        );
        if (existing.rows[0]) {
          await assertIdempotentRunInput(client, existing.rows[0], input);
          return { snapshot: await loadSnapshot(client, existing.rows[0]), created: false };
        }

        const userMessage = await findOrInsertUserMessage(client, input);
        await bindMessageAttachments(client, input, userMessage.id);
        const assistantMessageId = randomUUID();
        await client.query(
          `insert into agent_runs(
             id,request_id,user_id,conversation_id,user_message_id,mode,source,model_id,status,trace_id,created_at,updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$10)`,
          [input.runId, input.requestId, input.userId, input.conversationId, userMessage.id,
            input.mode, input.source, input.modelId ?? "mock", input.traceId, input.createdAt]
        );
        const nextSequence = await messageSequence(client, input.conversationId);
        await client.query(
          `insert into messages(id,conversation_id,user_id,run_id,role,content,status,sequence,created_at)
           values ($1,$2,$3,$4,'assistant','','pending',$5,$6)`,
          [assistantMessageId, input.conversationId, input.userId, input.runId, nextSequence, input.createdAt]
        );
        await client.query("update messages set run_id=$2 where id=$1", [userMessage.id, input.runId]);
        const inserted = await client.query<RunRow>(
          "update agent_runs set assistant_message_id=$2 where id=$1 returning *",
          [input.runId, assistantMessageId]
        );
        return { snapshot: await loadSnapshot(client, requireRow(inserted.rows[0])), created: true };
      });
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @returns 用户所属快照。 */
  async findById(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined> {
    try {
      const result = await this.pool.query<RunRow>("select * from agent_runs where id=$1 and user_id=$2", [runId, userId]);
      return result.rows[0] ? loadSnapshot(this.pool, result.rows[0]) : undefined;
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @returns 持久化用户消息绑定的附件集合。 */
  async listAttachmentDocumentIds(userId: string, runId: string): Promise<string[] | undefined> {
    try {
      const owned = await this.pool.query("select 1 from agent_runs where id=$1 and user_id=$2", [runId, userId]);
      if (!owned.rowCount) return undefined;
      const result = await this.pool.query<{ document_id: string }>(
        `select ma.document_id
           from agent_runs r
           join message_attachments ma on ma.message_id=r.user_message_id and ma.user_id=r.user_id
          where r.id=$1 and r.user_id=$2
          order by ma.ordinal`,
        [runId, userId]
      );
      return result.rows.map((row) => row.document_id);
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @param eventInput 已脱敏事件。 @returns 提交事件；终态竞争失败返回 undefined。 */
  async append(
    userId: string,
    runId: string,
    eventInput: AgentRunEventInputDto
  ): Promise<AgentRunStreamEventDto | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const locked = await client.query<RunRow>(
          "select * from agent_runs where id=$1 and user_id=$2 for update",
          [runId, userId]
        );
        const run = locked.rows[0];
        if (!run) return undefined;
        if (TERMINAL.has(run.status)) return undefined;
        const nextStatus = statusFromEvent(eventInput, run.status);
        if (!canTransition(run.status, nextStatus)) return undefined;
        const sequence = Number(run.version) + 1;
        const event = { ...eventInput, eventId: randomUUID(), sequence } as AgentRunStreamEventDto;
        await client.query(
          `insert into run_events(id,run_id,user_id,conversation_id,trace_id,sequence,event_type,payload,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [event.eventId, runId, userId, run.conversation_id, run.trace_id, sequence, event.type, event, event.createdAt]
        );
        const terminal = TERMINAL.has(nextStatus);
        const result = event.type === "run_result" ? event.result : null;
        const error = event.type === "run_error" ? event.error : null;
        await client.query(
          `update agent_runs set status=$3,intent=coalesce($4,intent),workflow_run_id=coalesce($5,workflow_run_id),
             result=coalesce($6,result),error=coalesce($7,error),version=$8,updated_at=$9,
             started_at=case when $3='running' then coalesce(started_at,$9) else started_at end,
             completed_at=case when $10 then coalesce(completed_at,$9) else completed_at end
           where id=$1 and user_id=$2`,
          [runId, userId, nextStatus, result?.intent ?? null, result?.reportWorkflow?.run.runId ?? null,
            result, error, sequence, event.createdAt, terminal]
        );
        if (terminal) {
          await client.query(
            `update messages set content=$3,status=$4,completed_at=$5
              where id=$1 and user_id=$2`,
            [run.assistant_message_id, userId,
              event.type === "run_result" ? event.result.answer : "",
              nextStatus === "succeeded" ? "completed" : nextStatus, event.createdAt]
          );
          await persistTerminalCitations(client, userId, run.assistant_message_id, event);
        }
        return event;
      });
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @param afterSequence 已消费序号。 @returns 后续事件或 undefined。 */
  async listEvents(userId: string, runId: string, afterSequence: number): Promise<AgentRunStreamEventDto[] | undefined> {
    try {
      const owned = await this.pool.query("select 1 from agent_runs where id=$1 and user_id=$2", [runId, userId]);
      if (!owned.rowCount) return undefined;
      const result = await this.pool.query<{ payload: AgentRunStreamEventDto }>(
        "select payload from run_events where run_id=$1 and user_id=$2 and sequence>$3 order by sequence",
        [runId, userId, afterSequence]
      );
      return result.rows.map((row) => row.payload);
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param before 陈旧阈值。 @param occurredAt 恢复时间。 @returns 每个被中断 Run 的失败事件。 */
  async recoverStale(before: string, occurredAt: string): Promise<AgentRunStreamEventDto[]> {
    try {
      const stale = await this.pool.query<{ id: string; user_id: string }>(
        `select id,user_id from agent_runs
          where status in ('queued','running','waiting_approval') and updated_at<$1 order by updated_at,id`,
        [before]
      );
      const recovered: AgentRunStreamEventDto[] = [];
      for (const row of stale.rows) {
        const snapshot = await this.findById(row.user_id, row.id);
        if (!snapshot) continue;
        const event = await this.append(row.user_id, row.id, {
          type: "run_error", runId: row.id, requestId: snapshot.requestId,
          traceId: `trace_${row.id}`, conversationId: snapshot.conversationId, createdAt: occurredAt,
          error: { code: "run_interrupted", message: "API 重启前的 Agent run 未完成，已安全终止。", requestId: snapshot.requestId }
        });
        if (event) recovered.push(event);
      }
      return recovered;
    } catch (cause) {
      throw mapRunError(cause);
    }
  }
}

/**
 * 把已授权且 indexed 的私有文档绑定到幂等用户消息。
 *
 * @param client 当前事务。
 * @param input Run 创建输入。
 * @param messageId 用户消息 ID。
 * @returns 绑定完成。
 */
async function bindMessageAttachments(
  client: pg.PoolClient,
  input: CreateRunInput,
  messageId: string
): Promise<void> {
  const attachmentDocumentIds = input.attachmentDocumentIds ?? [];
  if (attachmentDocumentIds.length === 0) return;
  const result = await client.query<{
    document_id: string;
    file_name: string;
    content_type: string;
    size_bytes: string | number;
  }>(
    `select d.id as document_id,u.file_name,u.content_type,u.size_bytes
       from chat_attachment_uploads u
       join documents d on d.id=u.document_id
       join lateral (
         select status
           from document_versions
          where document_id=d.id
          order by version desc
          limit 1
       ) v on true
      where d.id=any($1::uuid[]) and u.user_id=$2 and d.owner_user_id=$2 and d.scope='private'
        and u.status='indexed' and u.bound_message_id is null
        and d.deleted_at is null and v.status='indexed'
      order by d.id
      for update of u,d`,
    [attachmentDocumentIds, input.userId]
  );
  if (result.rows.length !== attachmentDocumentIds.length) {
    throw new RepositoryError("not_found", "One or more attachments were not found.");
  }
  const byId = new Map(result.rows.map((row) => [row.document_id, row]));
  for (const [ordinal, documentId] of attachmentDocumentIds.entries()) {
    const row = byId.get(documentId);
    if (!row) throw new RepositoryError("not_found", "One or more attachments were not found.");
    await client.query(
      `insert into message_attachments(
         id,user_id,message_id,document_id,ordinal,file_name,content_type,size_bytes,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), input.userId, messageId, documentId, ordinal, row.file_name,
        row.content_type, row.size_bytes, input.createdAt]
    );
    const bound = await client.query(
      `update chat_attachment_uploads set bound_message_id=$3,updated_at=$4
        where user_id=$1 and document_id=$2 and bound_message_id is null`,
      [input.userId, documentId, messageId, input.createdAt]
    );
    if (bound.rowCount !== 1) {
      throw new RepositoryError("conflict", "Attachment is already bound to another message.");
    }
  }
}

/**
 * 幂等重试必须保持模型、模式、来源和附件集合一致，防止同一 requestId 被改写语义。
 *
 * @param client 当前事务。
 * @param existing 已存在 Run。
 * @param input 本次请求。
 * @returns 输入一致时完成，否则抛 conflict。
 */
async function assertIdempotentRunInput(
  client: pg.PoolClient,
  existing: RunRow,
  input: CreateRunInput
): Promise<void> {
  const attachments = await client.query<{ document_id: string }>(
    `select ma.document_id
       from message_attachments ma
       join agent_runs r on r.user_message_id=ma.message_id
      where r.id=$1 and ma.user_id=$2
      order by ma.ordinal`,
    [existing.id, input.userId]
  );
  const actualIds = attachments.rows.map((row) => row.document_id);
  const expectedIds = input.attachmentDocumentIds ?? [];
  if (
    existing.model_id !== (input.modelId ?? "mock")
    || existing.mode !== input.mode
    || existing.source !== input.source
    || actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new RepositoryError("conflict", "Idempotent Run input does not match the existing request.");
  }
}

/** @param client 当前事务。 @param input Run 创建输入。 @returns 幂等用户消息行。 */
async function findOrInsertUserMessage(client: pg.PoolClient, input: CreateRunInput): Promise<{ id: string }> {
  const existing = await client.query<{ id: string }>(
    "select id from messages where conversation_id=$1 and user_id=$2 and client_message_id=$3",
    [input.conversationId, input.userId, input.clientMessageId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const id = randomUUID();
  await client.query(
    `insert into messages(id,conversation_id,user_id,role,content,status,client_message_id,sequence,created_at,completed_at)
     values ($1,$2,$3,'user',$4,'completed',$5,$6,$7,$7)`,
    [id, input.conversationId, input.userId, input.message, input.clientMessageId,
      await messageSequence(client, input.conversationId), input.createdAt]
  );
  return { id };
}

/** @param client 当前事务。 @param conversationId 会话标识。 @returns 下一个消息序号。 */
async function messageSequence(client: pg.PoolClient, conversationId: string): Promise<string> {
  const result = await client.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)+1 as sequence from messages where conversation_id=$1",
    [conversationId]
  );
  return result.rows[0]?.sequence ?? "1";
}

/** @param executor 查询执行器。 @param row Run 行。 @returns 含事件的快照。 */
async function loadSnapshot(executor: Pick<pg.Pool | pg.PoolClient, "query">, row: RunRow): Promise<AgentRunSnapshotDto> {
  const events = await executor.query<{ payload: AgentRunStreamEventDto }>(
    "select payload from run_events where run_id=$1 order by sequence",
    [row.id]
  );
  return {
    runId: row.id, requestId: row.request_id, conversationId: row.conversation_id, modelId: row.model_id, status: row.status,
    createdAt: postgresTimestampToIso(row.created_at), updatedAt: postgresTimestampToIso(row.updated_at),
    events: events.rows.map((item) => item.payload),
    result: row.result ? { ...row.result, modelId: row.model_id } : undefined,
    error: row.error ?? undefined
  };
}

/**
 * 在终态事务内写入 message citations；必须与 assistant message 终态同事务提交，
 * 任一失败整体回滚，避免回答已落库但证据链接丢失（或反之）的部分持久化状态。
 *
 * @param client 当前事务。
 * @param userId 当前用户。
 * @param assistantMessageId 预留的 assistant message ID。
 * @param event 已提交的终态事件。
 * @returns 写入完成；非 run_result 或无引用时无操作。
 */
async function persistTerminalCitations(
  client: pg.PoolClient,
  userId: string,
  assistantMessageId: string | null,
  event: AgentRunStreamEventDto
): Promise<void> {
  if (event.type !== "run_result" || !assistantMessageId || !event.result.citations?.length) return;
  await insertMessageCitations(client, {
    userId,
    messageId: assistantMessageId,
    citations: event.result.citations.map(toNewCitationInput),
    createdAt: event.createdAt
  });
}

/**
 * 把回答证据 DTO 映射为 citation 写入输入；序号按数组顺序从 1 开始，保证展示顺序稳定。
 *
 * @param citation 回答证据 DTO。
 * @param index 数组下标。
 * @returns citation 写入输入。
 */
function toNewCitationInput(citation: CitationDto, index: number): NewCitationInput {
  return {
    ordinal: index + 1,
    chunkId: citation.chunkId,
    claim: citation.heading ?? citation.source,
    quote: citation.quote,
    score: citation.confidence
  };
}

/** @param event 事件。 @param current 当前状态。 @returns 事件投影后的状态。 */function statusFromEvent(event: AgentRunEventInputDto, current: AgentRunStatusDto): AgentRunStatusDto {
  if (event.type === "run_status") return event.status;
  if (event.type === "run_error") return event.error.code === "request_cancelled" ? "cancelled" : "failed";
  if (event.type === "run_result") return event.result.ok ? "succeeded" : "failed";
  return current;
}

/** @param current 当前状态。 @param next 目标状态。 @returns 是否为单向合法迁移。 */
function canTransition(current: AgentRunStatusDto, next: AgentRunStatusDto): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || TERMINAL.has(next);
  if (current === "running") return next === "waiting_approval" || TERMINAL.has(next);
  if (current === "waiting_approval") return next === "running" || TERMINAL.has(next);
  return false;
}

interface RunRow {
  id: string; request_id: string; user_id: string; conversation_id: string;
  model_id: string;
  mode: "auto" | "report"; source: "composer" | "report_button";
  assistant_message_id: string | null; trace_id: string; status: AgentRunStatusDto;
  version: string | number; result: AgentRunSnapshotDto["result"] | null; error: ApiError | null;
  created_at: Date | string; updated_at: Date | string;
}

/** @template T 行类型。 @param row 可选行。 @returns 必须存在的行。 */
function requireRow<T>(row: T | undefined): T {
  if (!row) throw new RepositoryError("database_unavailable", "Database operation returned no row.");
  return row;
}

/** @param cause 内部异常。 @returns 不泄漏 PostgreSQL 细节的结构化错误。 */
function mapRunError(cause: unknown): RepositoryError {
  return cause instanceof RepositoryError
    ? cause
    : new RepositoryError("database_unavailable", "Run persistence is temporarily unavailable.", cause);
}
