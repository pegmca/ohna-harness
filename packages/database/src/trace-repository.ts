import {
  redactSensitiveValue,
  type Trace,
  type TraceEvent,
  type TracePersistenceContext,
  type TraceRunEventProjection,
  type TraceStore
} from "@aiagent/trace";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

/** @param pool PostgreSQL 连接池。 @returns PostgreSQL TraceStore。 */
export function createPostgresTraceStore(pool: pg.Pool): TraceStore {
  return new PostgresTraceStore(pool);
}

class PostgresTraceStore implements TraceStore {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /** @param context Trace 归属上下文。 @returns 初始化完成。 */
  async initialize(context: TracePersistenceContext): Promise<void> {
    try {
      const result = await this.pool.query(
        `insert into traces(id,request_id,run_id,user_id,status,started_at)
         select $1,$2,id,user_id,'running',$6 from agent_runs
          where id=$3 and user_id=$4 and conversation_id=$5
         on conflict (id) do nothing`,
        [context.traceId, context.requestId, context.runId, context.userId, context.conversationId, context.startedAt]
      );
      if ((result.rowCount ?? 0) === 0) {
        const owned = await this.pool.query("select 1 from traces where id=$1 and user_id=$2 and run_id=$3", [
          context.traceId, context.userId, context.runId
        ]);
        if (!owned.rowCount) throw new RepositoryError("not_found", "Trace owner run not found.");
      }
    } catch (cause) {
      throw mapTraceError(cause);
    }
  }

  /**
   * 在同一事务中写入已脱敏 Trace 事件及其 Run 投影，防止两套事实双写漂移。
   *
   * @param context Trace 归属上下文。
   * @param event recorder 产生的 canonical event。
   * @returns 提交后的 Run 投影。
   */
  async append(context: TracePersistenceContext, event: TraceEvent): Promise<TraceRunEventProjection | undefined> {
    try {
      // adapter 再做一次防御性脱敏，确保未来非标准 recorder 也不能把原值写库。
      const safeEvent = redactSensitiveValue(event);
      return await withTransaction(this.pool, async (client) => {
        const runResult = await client.query<RunLockRow>(
          "select conversation_id,trace_id,version,status from agent_runs where id=$1 and user_id=$2 for update",
          [context.runId, context.userId]
        );
        const run = runResult.rows[0];
        if (!run || run.trace_id !== context.traceId || run.conversation_id !== context.conversationId) return undefined;
        if (["succeeded", "failed", "cancelled"].includes(run.status)) return undefined;
        const traceResult = await client.query<{ last_sequence: string | number }>(
          "select last_sequence from traces where id=$1 and run_id=$2 and user_id=$3 for update",
          [context.traceId, context.runId, context.userId]
        );
        const trace = traceResult.rows[0];
        if (!trace) return undefined;
        const traceSequence = Number(trace.last_sequence) + 1;
        const runSequence = Number(run.version) + 1;
        const eventId = randomUUID();
        const projection: TraceRunEventProjection = {
          eventId, sequence: runSequence, runId: context.runId, requestId: context.requestId,
          traceId: context.traceId, conversationId: context.conversationId,
          createdAt: safeEvent.createdAt, type: "trace_event", event: safeEvent
        };
        await client.query(
          `insert into trace_events(
             id,trace_id,run_id,user_id,sequence,event_type,span_id,parent_span_id,stage,payload,created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [eventId, context.traceId, context.runId, context.userId, traceSequence, safeEvent.type,
            safeEvent.spanId ?? null, safeEvent.parentSpanId ?? null, safeEvent.stage ?? null, safeEvent, safeEvent.createdAt]
        );
        await client.query(
          `insert into run_events(id,run_id,user_id,conversation_id,trace_id,sequence,event_type,payload,created_at)
           values ($1,$2,$3,$4,$5,$6,'trace_event',$7,$8)`,
          [eventId, context.runId, context.userId, context.conversationId, context.traceId,
            runSequence, projection, safeEvent.createdAt]
        );
        await client.query("update traces set last_sequence=$2 where id=$1", [context.traceId, traceSequence]);
        await client.query("update agent_runs set version=$3,updated_at=$4 where id=$1 and user_id=$2", [
          context.runId, context.userId, runSequence, safeEvent.createdAt
        ]);
        return projection;
      });
    } catch (cause) {
      throw mapTraceError(cause);
    }
  }

  /** @param context Trace 归属上下文。 @param trace 最终 Trace。 @returns 汇总更新完成。 */
  async finalize(context: TracePersistenceContext, trace: Trace): Promise<void> {
    try {
      const summary = redactSensitiveValue(trace.summary);
      const result = await this.pool.query(
        `update traces set status=$4,duration_ms=$5,model_call_count=$6,tool_call_count=$7,
           retrieval_count=$8,error_count=$9,input_tokens=$10,output_tokens=$11,
           known_token_total=$12,unknown_token_call_count=$13,completed_at=$14
         where id=$1 and run_id=$2 and user_id=$3`,
        [context.traceId, context.runId, context.userId, summary.status, summary.durationMs,
          summary.modelCallCount, summary.toolCallCount, summary.retrievalCount, summary.errorCount,
          summary.inputTokens === "unknown" ? null : summary.inputTokens,
          summary.outputTokens === "unknown" ? null : summary.outputTokens,
          summary.knownTokenTotal, summary.unknownTokenCallCount, trace.completedAt ?? null]
      );
      if (!result.rowCount) throw new RepositoryError("not_found", "Trace not found.");
    } catch (cause) {
      throw mapTraceError(cause);
    }
  }

  /** @param userId 当前用户。 @param requestId 请求标识。 @param afterSequence 事件游标。 @returns Trace。 */
  async getByRequestId(userId: string, requestId: string, afterSequence = 0): Promise<Trace | undefined> {
    try {
      const traceResult = await this.pool.query<TraceRow>(
        "select * from traces where request_id=$1 and user_id=$2",
        [requestId, userId]
      );
      const row = traceResult.rows[0];
      if (!row) return undefined;
      const events = await this.pool.query<{ payload: TraceEvent }>(
        "select payload from trace_events where trace_id=$1 and user_id=$2 and sequence>$3 order by sequence",
        [row.id, userId, afterSequence]
      );
      return {
        traceId: row.id, requestId: row.request_id,
        startedAt: postgresTimestampToIso(row.started_at),
        completedAt: row.completed_at ? postgresTimestampToIso(row.completed_at) : undefined,
        summary: {
          status: row.status, durationMs: row.duration_ms, modelCallCount: row.model_call_count,
          toolCallCount: row.tool_call_count, retrievalCount: row.retrieval_count,
          inputTokens: row.input_tokens ?? "unknown", outputTokens: row.output_tokens ?? "unknown",
          knownTokenTotal: row.known_token_total, unknownTokenCallCount: row.unknown_token_call_count,
          errorCount: row.error_count
        },
        events: events.rows.map((item) => item.payload)
      };
    } catch (cause) {
      throw mapTraceError(cause);
    }
  }
}

interface RunLockRow {
  conversation_id: string;
  trace_id: string;
  version: string | number;
  status: string;
}

interface TraceRow {
  id: string; request_id: string; status: Trace["summary"]["status"]; duration_ms: number;
  model_call_count: number; tool_call_count: number; retrieval_count: number; error_count: number;
  input_tokens: number | null; output_tokens: number | null; known_token_total: number;
  unknown_token_call_count: number; started_at: Date | string; completed_at: Date | string | null;
}

/** @param cause 未知基础设施异常。 @returns 不泄漏 SQL 或连接信息的结构化错误。 */
function mapTraceError(cause: unknown): RepositoryError {
  return cause instanceof RepositoryError
    ? cause
    : new RepositoryError("database_unavailable", "Trace persistence is temporarily unavailable.", cause);
}
