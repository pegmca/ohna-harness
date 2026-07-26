import { redactSensitiveValue, type TraceApprovalEvent, type TraceRunEventProjection } from "@aiagent/trace";
import type { ApprovalDecideResult, ApprovalDecisionInput } from "@aiagent/tools";
import { ApprovalRepositoryError } from "@aiagent/tools";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { decideApprovalWithClient } from "./approval-repository.js";
import { withTransaction } from "./postgres.js";

/** 审批决定与 approval decided 事件的同事务结果；event 为空表示 Run 已终态或 Trace 不存在，决定仍然提交。 */
export interface PostgresApprovalDecisionOutcome {
  result: ApprovalDecideResult;
  /** 同一事务提交的 Run 事件投影，供提交后做 live fan-out。 */
  event?: TraceRunEventProjection;
}

/** 审批决定服务：输入与 repository decide 相同，输出附带同事务事件投影。 */
export type ApprovalDecisionService = (input: ApprovalDecisionInput) => Promise<PostgresApprovalDecisionOutcome>;

interface RunLockRow {
  request_id: string;
  conversation_id: string;
  trace_id: string;
  version: string | number;
  status: string;
}

/**
 * 创建审批决定组合服务，收口 PR-05 遗留边界：决定写入与 approval decided trace event
 * 在同一数据库事务提交，避免「决定已持久化但 Run 终态前事件缺失」的双写漂移。
 *
 * 事件追加复用 Trace 的 sequence 分配语义（锁 Run + 锁 Trace，version/last_sequence 各加一），
 * Run 已终态或 Trace 行不存在（Trace 持久化降级）时只提交决定，不回滚。
 *
 * @param pool PostgreSQL 连接池。
 * @returns 审批决定服务。
 */
export function createPostgresApprovalDecisionService(pool: pg.Pool): ApprovalDecisionService {
  return async (input) => {
    try {
      return await withTransaction(pool, async (client) => {
        const result = await decideApprovalWithClient(client, input);
        // 幂等命中时事件已随首次决定提交；冲突/过期/不存在不产生事件。
        if (!result.ok || result.idempotent) return { result };
        const record = result.record;
        const runResult = await client.query<RunLockRow>(
          "select request_id,conversation_id,trace_id,version,status from agent_runs where id=$1 and user_id=$2 for update",
          [record.runId, record.userId]
        );
        const run = runResult.rows[0];
        if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return { result };
        const traceResult = await client.query<{ last_sequence: string | number }>(
          "select last_sequence from traces where id=$1 and run_id=$2 and user_id=$3 for update",
          [run.trace_id, record.runId, record.userId]
        );
        const trace = traceResult.rows[0];
        if (!trace) return { result };
        const traceSequence = Number(trace.last_sequence) + 1;
        const runSequence = Number(run.version) + 1;
        const createdAt = record.decidedAt ?? input.decidedAt;
        // adapter 侧再脱敏一次，防止未来调用方绕过 API 层直接传入原值。
        // 决定成功提交后 status 只会是 approved/rejected，满足 TraceApprovalEvent 的取值约束。
        const safeEvent = redactSensitiveValue<TraceApprovalEvent>({
          type: "approval",
          id: `${record.traceId}_${record.approvalId}_${record.status}_${Date.now().toString(36)}`,
          traceId: record.traceId,
          requestId: record.requestId,
          approvalId: record.approvalId,
          toolName: record.toolName ?? "unknown",
          status: record.status as "approved" | "rejected",
          reason: record.reason ?? "",
          inputPreview: record.inputPreview ?? null,
          reviewerNote: record.reviewerNote,
          inputDigest: record.inputDigest,
          reasonCode: record.reasonCode,
          createdAt
        });
        const eventId = randomUUID();
        const projection: TraceRunEventProjection = {
          eventId, sequence: runSequence, runId: record.runId, requestId: run.request_id,
          traceId: run.trace_id, conversationId: run.conversation_id,
          createdAt, type: "trace_event", event: safeEvent
        };
        await client.query(
          `insert into trace_events(
             id,trace_id,run_id,user_id,sequence,event_type,span_id,parent_span_id,stage,payload,created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [eventId, run.trace_id, record.runId, record.userId, traceSequence, safeEvent.type,
            safeEvent.spanId ?? null, safeEvent.parentSpanId ?? null, safeEvent.stage ?? null,
            safeEvent, createdAt]
        );
        await client.query(
          `insert into run_events(id,run_id,user_id,conversation_id,trace_id,sequence,event_type,payload,created_at)
           values ($1,$2,$3,$4,$5,$6,'trace_event',$7,$8)`,
          [eventId, record.runId, record.userId, run.conversation_id, run.trace_id, runSequence, projection, createdAt]
        );
        await client.query("update traces set last_sequence=$2 where id=$1", [run.trace_id, traceSequence]);
        await client.query("update agent_runs set version=$3,updated_at=$4 where id=$1 and user_id=$2", [
          record.runId, record.userId, runSequence, createdAt
        ]);
        return { result, event: projection };
      });
    } catch (cause) {
      throw cause instanceof ApprovalRepositoryError
        ? cause
        : new ApprovalRepositoryError("database_unavailable", "Approval persistence is temporarily unavailable.", cause);
    }
  };
}
