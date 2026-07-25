import type {
  ApprovalDecideResult,
  ApprovalDecisionInput,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalRequestInput
} from "@aiagent/tools";
import { ApprovalRepositoryError } from "@aiagent/tools";

/**
 * 创建进程内 Approval repository；仅供本地 dev 与 API 单测使用，重启即丢失。
 *
 * 生产 server 必须通过 ApiServerOptions.approvalRepository 注入 PostgreSQL adapter。
 *
 * @returns 内存 Approval repository。
 */
export function createInMemoryApprovalRepository(): ApprovalRepository {
  const records = new Map<string, ApprovalRecord>();

  return {
    async requestApproval(input: ApprovalRequestInput): Promise<ApprovalRecord> {
      const existing = records.get(input.approvalId);
      if (existing) {
        // 与 PostgreSQL adapter 一致：相同 id 但绑定信息不同视为重放/挪用冲突。
        if (existing.inputDigest !== input.inputDigest || existing.runId !== input.runId || existing.userId !== input.userId) {
          throw new ApprovalRepositoryError("conflict", "Approval request conflicts with an existing record.");
        }
        return existing;
      }
      const record: ApprovalRecord = {
        approvalId: input.approvalId,
        runId: input.runId,
        requestId: input.requestId,
        traceId: input.traceId,
        userId: input.userId,
        toolName: input.toolName,
        permissionLevel: input.permissionLevel,
        reason: input.reason,
        reasonCode: input.reasonCode,
        inputDigest: input.inputDigest,
        inputPreview: input.inputPreview,
        status: "pending",
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt
      };
      records.set(record.approvalId, record);
      return record;
    },

    async decide(input: ApprovalDecisionInput): Promise<ApprovalDecideResult> {
      const record = records.get(input.approvalId);
      // 不存在与归属不符统一 not_found，避免泄漏资源是否存在。
      if (!record || record.runId !== input.runId || record.userId !== input.reviewerUserId) {
        return { ok: false, code: "not_found" };
      }
      if (record.inputDigest !== input.expectedInputDigest) return { ok: false, code: "conflict", conflictReason: "digest", record };
      if (record.status === "pending") {
        if (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(input.decidedAt)) {
          const expired = { ...record, status: "expired" as const };
          records.set(record.approvalId, expired);
          return { ok: false, code: "expired", record: expired };
        }
        const decided: ApprovalRecord = {
          ...record,
          status: input.decision,
          decision: input.decision,
          decidedAt: input.decidedAt,
          reviewerUserId: input.reviewerUserId,
          reviewerNote: input.reviewerNote
        };
        records.set(record.approvalId, decided);
        return { ok: true, idempotent: false, record: decided };
      }
      if (record.decision === input.decision && record.reviewerUserId === input.reviewerUserId) {
        return { ok: true, idempotent: true, record };
      }
      return { ok: false, code: "conflict", conflictReason: "decision", record };
    },

    async findApprovedDecision(userId: string, approvalId: string): Promise<ApprovalRecord | undefined> {
      const record = records.get(approvalId);
      if (!record || record.userId !== userId) return undefined;
      if (record.status === "pending" && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
        records.set(approvalId, { ...record, status: "expired" });
        return undefined;
      }
      return record.status === "approved" ? record : undefined;
    }
  };
}
