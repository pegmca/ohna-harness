import type {
  ApprovalDecideResult,
  ApprovalDecisionInput,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalRequestInput
} from "./approval-types.js";
import { ApprovalRepositoryError } from "./approval-types.js";
import type pg from "pg";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";

/**
 * 创建 Approval PostgreSQL adapter；决定操作使用单行 CAS，过期转移与回读同事务完成。
 *
 * @param pool PostgreSQL 连接池。
 * @returns Approval repository。
 */
export function createPostgresApprovalRepository(pool: pg.Pool): ApprovalRepository {
  return new PostgresApprovalRepository(pool);
}

class PostgresApprovalRepository implements ApprovalRepository {
  /** @param pool PostgreSQL 连接池。 */
  constructor(private readonly pool: pg.Pool) {}

  /** @param input 审批请求与归属信息。 @returns 新建或幂等回读的审批记录。 */
  async requestApproval(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query(
          `insert into tool_approvals(
             id,run_id,request_id,trace_id,user_id,tool_name,permission_level,reason,reason_code,
             input_digest,input_preview,status,requested_at,expires_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13)
           on conflict (id) do nothing`,
          [input.approvalId, input.runId, input.requestId, input.traceId, input.userId,
            input.toolName ?? null, input.permissionLevel ?? null, input.reason ?? null,
            input.reasonCode ?? null, input.inputDigest,
            input.inputPreview === undefined ? null : JSON.stringify(input.inputPreview),
            input.requestedAt, input.expiresAt]
        );
        const existing = await client.query<ApprovalRow>("select * from tool_approvals where id=$1", [input.approvalId]);
        const row = requireRow(existing.rows[0]);
        // 相同 id 但绑定信息不同属于重放/挪用尝试，必须拒绝而不是静默复用。
        if (row.input_digest !== input.inputDigest || row.run_id !== input.runId || row.user_id !== input.userId) {
          throw new ApprovalRepositoryError("conflict", "Approval request conflicts with an existing record.");
        }
        return mapRow(row);
      });
    } catch (cause) {
      throw mapApprovalError(cause);
    }
  }

  /** @param input 决定内容与绑定校验。 @returns 决定结果；幂等/conflict/过期语义见 port 文档。 */
  async decide(input: ApprovalDecisionInput): Promise<ApprovalDecideResult> {
    try {
      return await withTransaction(this.pool, async (client) => decideApprovalWithClient(client, input));
    } catch (cause) {
      throw mapApprovalError(cause);
    }
  }

  /** @param userId 当前用户。 @param runId 审批所属 Run。 @param approvalId 审批标识。 @returns 已批准且未过期记录。 */
  async findApprovedDecision(userId: string, runId: string, approvalId: string): Promise<ApprovalRecord | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        // gate 读路径顺手把过期 pending 原子转为 expired，保证过期审批不会被后续放行。
        await client.query(
          `update tool_approvals set status='expired'
            where id=$1 and run_id=$2 and user_id=$3 and status='pending' and expires_at is not null and expires_at <= now()`,
          [approvalId, runId, userId]
        );
        const result = await client.query<ApprovalRow>(
          "select * from tool_approvals where id=$1 and run_id=$2 and user_id=$3 and status='approved'",
          [approvalId, runId, userId]
        );
        return result.rows[0] ? mapRow(result.rows[0]) : undefined;
      });
    } catch (cause) {
      throw mapApprovalError(cause);
    }
  }
}

/**
 * 在已有事务内执行审批决定 CAS；package 内部共享给「决定 + 事件同事务」的组合服务。
 *
 * @param client 当前事务持有的 PostgreSQL client。
 * @param input 决定内容与绑定校验。
 * @returns 决定结果；幂等/conflict/过期语义见 port 文档。
 */
export async function decideApprovalWithClient(client: pg.PoolClient, input: ApprovalDecisionInput): Promise<ApprovalDecideResult> {
  // 过期转移与决定写入都是单行原子 UPDATE，并发 approve/reject 只有一个能命中。
  const updated = await client.query<ApprovalRow>(
    `update tool_approvals
        set status=$4, decision=$4, decided_at=$5, reviewer_user_id=$1, reviewer_note=$6
      where id=$3 and run_id=$2 and user_id=$1 and input_digest=$7
        and status='pending' and (expires_at is null or expires_at > now())
      returning *`,
    [input.reviewerUserId, input.runId, input.approvalId, input.decision,
      input.decidedAt, input.reviewerNote ?? null, input.expectedInputDigest]
  );
  if (updated.rows[0]) return { ok: true, idempotent: false, record: mapRow(updated.rows[0]) };

  const existing = await client.query<ApprovalRow>(
    "select * from tool_approvals where id=$1 and run_id=$2 and user_id=$3",
    [input.approvalId, input.runId, input.reviewerUserId]
  );
  const row = existing.rows[0];
  // 不存在与归属不符统一 not_found，避免泄漏资源是否存在。
  if (!row) return { ok: false, code: "not_found" as const };
  if (row.input_digest !== input.expectedInputDigest) {
    return { ok: false, code: "conflict" as const, conflictReason: "digest" as const, record: mapRow(row) };
  }
  if (row.status === "pending") {
    // pending 但未命中 CAS 只可能是已过期；先原子转 expired 再报告。
    const expired = await client.query<ApprovalRow>(
      `update tool_approvals set status='expired'
        where id=$1 and run_id=$2 and user_id=$3 and status='pending' returning *`,
      [input.approvalId, input.runId, input.reviewerUserId]
    );
    return { ok: false, code: "expired" as const, record: mapRow(expired.rows[0] ?? row) };
  }
  if (row.decision === input.decision && row.reviewer_user_id === input.reviewerUserId) {
    return { ok: true, idempotent: true, record: mapRow(row) };
  }
  return { ok: false, code: "conflict" as const, conflictReason: "decision" as const, record: mapRow(row) };
}

interface ApprovalRow {
  id: string; run_id: string; request_id: string; trace_id: string; user_id: string;
  tool_name: string | null; permission_level: ApprovalRecord["permissionLevel"] | null;
  reason: string | null; reason_code: string | null; input_digest: string;
  input_preview: unknown; status: ApprovalRecord["status"]; decision: ApprovalRecord["decision"] | null;
  requested_at: Date | string; decided_at: Date | string | null; expires_at: Date | string | null;
  reviewer_user_id: string | null; reviewer_note: string | null;
}

/** @param row 数据库行。 @returns 领域审批记录。 */
function mapRow(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    traceId: row.trace_id,
    userId: row.user_id,
    toolName: row.tool_name ?? undefined,
    permissionLevel: row.permission_level ?? undefined,
    reason: row.reason ?? undefined,
    reasonCode: row.reason_code ?? undefined,
    inputDigest: row.input_digest,
    inputPreview: row.input_preview ?? undefined,
    status: row.status,
    decision: row.decision ?? undefined,
    requestedAt: postgresTimestampToIso(row.requested_at),
    decidedAt: row.decided_at ? postgresTimestampToIso(row.decided_at) : undefined,
    expiresAt: row.expires_at ? postgresTimestampToIso(row.expires_at) : undefined,
    reviewerUserId: row.reviewer_user_id ?? undefined,
    reviewerNote: row.reviewer_note ?? undefined
  };
}

/** @template T 行类型。 @param row 可选行。 @returns 必须存在的行。 */
function requireRow<T>(row: T | undefined): T {
  if (!row) throw new ApprovalRepositoryError("database_unavailable", "Database operation returned no row.");
  return row;
}

/** @param cause 内部异常。 @returns 不泄漏 PostgreSQL 细节的结构化错误。 */
function mapApprovalError(cause: unknown): ApprovalRepositoryError {
  return cause instanceof ApprovalRepositoryError
    ? cause
    : new ApprovalRepositoryError("database_unavailable", "Approval persistence is temporarily unavailable.", cause);
}
