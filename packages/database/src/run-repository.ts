import type { RunEventInputDtoV2, RunSnapshotDtoV2, RunStatusDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

/** 终态集合：进入后 appendEvent 一律拒绝（返回 undefined），保证终态不可回退。 */
const TERMINAL = new Set<RunStatusDtoV2>(["completed", "failed", "cancelled", "interrupted"]);

export interface CreateRunInputV2 {
  runId: string;
  requestId: string;
  userId: string;
  conversationId: string;
  /** 触发 Run 的用户消息文本（幂等写入 messages_v2）。 */
  message: string;
  clientMessageId: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
  modelId: string;
  createdAt: string;
}

/**
 * Run 存储端口（docs/worktree/05 RunStore 草案）：
 * 线性消息 + append-only 事件，SSE 重放与 trace 详情同源。
 */
export interface RunRepository {
  create(input: CreateRunInputV2): Promise<{ snapshot: RunSnapshotDtoV2; created: boolean }>;
  findById(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined>;
  /**
   * 追加事件：同事务分配 sequence、推进 runs_v2.last_event_sequence 高水位、按事件推导 status。
   * run 不存在或已终态时返回 undefined。
   */
  appendEvent(userId: string, runId: string, event: RunEventInputDtoV2): Promise<RunStreamEventDtoV2 | undefined>;
  /** SSE 重放源：返回 sequence > afterSequence 的全部事件，升序。 */
  listEvents(userId: string, runId: string, afterSequence: number): Promise<RunStreamEventDtoV2[] | undefined>;
  /** 崩溃恢复：把 updatedAt 早于 before 的非终态 run 标记 interrupted 并补 run_status 事件。 */
  recoverStale(before: string, occurredAt: string): Promise<RunStreamEventDtoV2[]>;
}

/**
 * 创建 Run PostgreSQL adapter；行锁同时保护事件 sequence 分配、高水位推进与终态 CAS。
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

  /**
   * 在同一事务内幂等写入用户消息并创建 Run；request_id 冲突时返回既有 Run（created=false）。
   *
   * @param input Run 与触发消息输入。
   * @returns 新建或已存在的 Run 快照。
   */
  async create(input: CreateRunInputV2): Promise<{ snapshot: RunSnapshotDtoV2; created: boolean }> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const conversation = await client.query(
          "select id from conversations_v2 where id=$1 and user_id=$2 for update",
          [input.conversationId, input.userId]
        );
        if (!conversation.rowCount) throw new RepositoryError("not_found", "Conversation not found.");
        const existing = await client.query<RunRow>(
          "select * from runs_v2 where request_id=$1 and user_id=$2",
          [input.requestId, input.userId]
        );
        if (existing.rows[0]) {
          return { snapshot: mapSnapshot(existing.rows[0]), created: false };
        }
        const userMessageId = await findOrInsertUserMessage(client, input);
        const inserted = await client.query<RunRow>(
          `insert into runs_v2(
             id,request_id,user_id,conversation_id,user_message_id,model_id,mode,source,status,
             last_event_sequence,created_at,updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',0,$9,$9)
           returning *`,
          [input.runId, input.requestId, input.userId, input.conversationId, userMessageId,
            input.modelId, input.mode, input.source, input.createdAt]
        );
        // 循环外键要求先建 run 再回填消息的 run_id。
        await client.query("update messages_v2 set run_id=$2 where id=$1", [userMessageId, input.runId]);
        return { snapshot: mapSnapshot(requireRow(inserted.rows[0])), created: true };
      });
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @returns 用户所属快照。 */
  async findById(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined> {
    try {
      const result = await this.pool.query<RunRow>(
        "select * from runs_v2 where id=$1 and user_id=$2",
        [runId, userId]
      );
      return result.rows[0] ? mapSnapshot(result.rows[0]) : undefined;
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /**
   * 追加 canonical 事件：行锁内分配 sequence、写 run_events_v2、推进高水位与状态机。
   * 先落库后广播由调用方保证（本方法提交后才 publish）。
   *
   * @param userId 当前用户。
   * @param runId Run 标识。
   * @param eventInput 已脱敏事件输入。
   * @returns 提交事件；run 不存在或已终态返回 undefined。
   */
  async appendEvent(
    userId: string,
    runId: string,
    eventInput: RunEventInputDtoV2
  ): Promise<RunStreamEventDtoV2 | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const locked = await client.query<RunRow>(
          "select * from runs_v2 where id=$1 and user_id=$2 for update",
          [runId, userId]
        );
        const run = locked.rows[0];
        if (!run) return undefined;
        if (TERMINAL.has(run.status)) return undefined;
        const nextStatus = statusFromEvent(eventInput, run.status);
        if (!canTransition(run.status, nextStatus)) return undefined;
        const sequence = Number(run.last_event_sequence) + 1;
        const event: RunStreamEventDtoV2 = { ...eventInput, eventId: randomUUID(), sequence };
        await client.query(
          `insert into run_events_v2(id,run_id,user_id,conversation_id,sequence,event_type,payload,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [event.eventId, runId, userId, run.conversation_id, sequence, event.type,
            JSON.stringify(event.payload), event.createdAt]
        );
        const terminal = TERMINAL.has(nextStatus);
        const terminalError = terminalErrorFromEvent(eventInput, nextStatus);
        await client.query(
          `update runs_v2 set status=$3,error=coalesce($4,error),last_event_sequence=$5,updated_at=$6,
             started_at=case when $3='running' then coalesce(started_at,$6) else started_at end,
             completed_at=case when $7 then coalesce(completed_at,$6) else completed_at end
           where id=$1 and user_id=$2`,
          [runId, userId, nextStatus, terminalError ? JSON.stringify(terminalError) : null,
            sequence, event.createdAt, terminal]
        );
        return event;
      });
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId Run 标识。 @param afterSequence 已消费序号。 @returns 后续事件或 undefined。 */
  async listEvents(userId: string, runId: string, afterSequence: number): Promise<RunStreamEventDtoV2[] | undefined> {
    try {
      const owned = await this.pool.query("select 1 from runs_v2 where id=$1 and user_id=$2", [runId, userId]);
      if (!owned.rowCount) return undefined;
      const result = await this.pool.query<RunEventRow>(
        `select e.*, r.request_id from run_events_v2 e
          join runs_v2 r on r.id=e.run_id
         where e.run_id=$1 and e.user_id=$2 and e.sequence>$3 order by e.sequence`,
        [runId, userId, afterSequence]
      );
      return result.rows.map(mapRunEvent);
    } catch (cause) {
      throw mapRunError(cause);
    }
  }

  /**
   * 把早于阈值的非终态 Run 标记为 interrupted 并补 run_status 事件（崩溃/部署打断恢复入口）。
   *
   * @param before 陈旧阈值。
   * @param occurredAt 恢复时间。
   * @returns 每个被中断 Run 的 run_status 事件。
   */
  async recoverStale(before: string, occurredAt: string): Promise<RunStreamEventDtoV2[]> {
    try {
      const stale = await this.pool.query<{ id: string; user_id: string; request_id: string; conversation_id: string }>(
        `select id,user_id,request_id,conversation_id from runs_v2
          where status in ('queued','running') and updated_at<$1 order by updated_at,id`,
        [before]
      );
      const recovered: RunStreamEventDtoV2[] = [];
      for (const row of stale.rows) {
        const event = await this.appendEvent(row.user_id, row.id, {
          type: "run_status",
          runId: row.id,
          requestId: row.request_id,
          conversationId: row.conversation_id,
          createdAt: occurredAt,
          payload: { status: "interrupted", message: "API 重启前的 Agent run 未完成，已标记为中断。" }
        });
        if (event) recovered.push(event);
      }
      return recovered;
    } catch (cause) {
      throw mapRunError(cause);
    }
  }
}

interface RunRow {
  id: string;
  request_id: string;
  user_id: string;
  conversation_id: string;
  user_message_id: string;
  model_id: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
  status: RunStatusDtoV2;
  error: RunSnapshotDtoV2["error"] | null;
  last_event_sequence: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

interface RunEventRow {
  id: string;
  run_id: string;
  request_id: string;
  conversation_id: string;
  sequence: string | number;
  event_type: RunStreamEventDtoV2["type"];
  payload: unknown;
  created_at: Date | string;
}

/**
 * 幂等写入触发 Run 的用户消息（content 为纯文本，role='user'），随后回填 run_id。
 *
 * @param client 当前事务。
 * @param input Run 创建输入。
 * @returns 用户消息 ID。
 */
async function findOrInsertUserMessage(client: pg.PoolClient, input: CreateRunInputV2): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from messages_v2 where conversation_id=$1 and user_id=$2 and client_message_id=$3",
    [input.conversationId, input.userId, input.clientMessageId]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const sequenceResult = await client.query<{ sequence: string }>(
    "select coalesce(max(sequence),0)+1 as sequence from messages_v2 where conversation_id=$1",
    [input.conversationId]
  );
  const id = randomUUID();
  // run_id 先置空：循环外键要求 run 行插入后再由调用方回填。
  await client.query(
    `insert into messages_v2(id,conversation_id,user_id,run_id,role,content,message_type,client_message_id,sequence,created_at)
     values ($1,$2,$3,null,'user',$4,'normal',$5,$6,$7)`,
    [id, input.conversationId, input.userId, JSON.stringify(input.message),
      input.clientMessageId, sequenceResult.rows[0]?.sequence ?? "1", input.createdAt]
  );
  return id;
}

/** @param row Run 行。 @returns 对外快照 DTO。 */
function mapSnapshot(row: RunRow): RunSnapshotDtoV2 {
  return {
    runId: row.id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    modelId: row.model_id,
    mode: row.mode,
    source: row.source,
    status: row.status,
    lastEventSequence: Number(row.last_event_sequence),
    error: row.error ?? undefined,
    createdAt: postgresTimestampToIso(row.created_at),
    updatedAt: postgresTimestampToIso(row.updated_at),
    startedAt: row.started_at ? postgresTimestampToIso(row.started_at) : undefined,
    completedAt: row.completed_at ? postgresTimestampToIso(row.completed_at) : undefined
  };
}

/** @param row run_events_v2 行。 @returns canonical 事件 envelope。 */
function mapRunEvent(row: RunEventRow): RunStreamEventDtoV2 {
  return {
    eventId: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    type: row.event_type,
    payload: row.payload,
    createdAt: postgresTimestampToIso(row.created_at)
  };
}

/**
 * 从事件推导 Run 下一状态（终态推导的消费点）：
 * run_status 显式携带；run_error 按错误码区分取消/失败；
 * agent_end 检查 loop 兜底 error 与末条 assistant 的 stopReason（aborted→cancelled、error→failed）。
 *
 * @param event 事件输入。
 * @param current 当前状态。
 * @returns 推导后的状态。
 */
function statusFromEvent(event: RunEventInputDtoV2, current: RunStatusDtoV2): RunStatusDtoV2 {
  if (event.type === "run_status") {
    const payload = event.payload as { status?: RunStatusDtoV2 };
    return payload.status ?? current;
  }
  if (event.type === "run_error") {
    const payload = event.payload as { error?: { code?: string } };
    return payload.error?.code === "request_cancelled" ? "cancelled" : "failed";
  }
  if (event.type === "agent_end") {
    const payload = event.payload as {
      error?: { code: string };
      messages?: { role: string; stopReason?: string }[];
    };
    if (payload.error) return "failed";
    const lastAssistant = [...(payload.messages ?? [])].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") return "cancelled";
    if (lastAssistant?.stopReason === "error") return "failed";
    return "completed";
  }
  return current;
}

/**
 * 终态事件的结构化错误（写 runs_v2.error，已脱敏）。
 *
 * @param event 事件输入。
 * @param nextStatus 推导后的终态。
 * @returns 错误对象；正常完成返回 undefined。
 */
function terminalErrorFromEvent(
  event: RunEventInputDtoV2,
  nextStatus: RunStatusDtoV2
): RunSnapshotDtoV2["error"] | undefined {
  if (event.type === "run_error") {
    return (event.payload as { error?: RunSnapshotDtoV2["error"] }).error;
  }
  if (event.type === "agent_end" && (nextStatus === "failed" || nextStatus === "cancelled")) {
    const payload = event.payload as { error?: { code: string; message: string } };
    if (payload.error) return { ...payload.error, requestId: event.requestId };
    return {
      code: nextStatus === "cancelled" ? "request_cancelled" : "agent_failed",
      message: nextStatus === "cancelled" ? "Agent run 已取消。" : "Agent run 执行失败。",
      requestId: event.requestId
    };
  }
  return undefined;
}

/** @param current 当前状态。 @param next 目标状态。 @returns 是否为单向合法迁移。 */
function canTransition(current: RunStatusDtoV2, next: RunStatusDtoV2): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || TERMINAL.has(next);
  if (current === "running") return TERMINAL.has(next);
  return false;
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
