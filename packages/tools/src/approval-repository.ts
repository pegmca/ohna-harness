import type { ToolApprovalDecisionValueDto, ToolPermissionLevelDto } from "@aiagent/types";

/** Approval 请求默认过期时间：30 分钟；调用方可按部署需要注入更短 TTL。 */
export const APPROVAL_REQUEST_TTL_MS = 30 * 60 * 1000;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** Approval 持久化记录；`inputDigest` 为空串表示原请求未绑定输入摘要。 */
export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  requestId: string;
  traceId: string;
  userId: string;
  toolName?: string;
  permissionLevel?: ToolPermissionLevelDto;
  reason?: string;
  reasonCode?: string;
  inputDigest: string;
  inputPreview?: unknown;
  status: ApprovalStatus;
  decision?: ToolApprovalDecisionValueDto;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
  reviewerUserId?: string;
  reviewerNote?: string;
}

/** 创建审批请求的输入；`requestedAt` 与 `expiresAt` 由调用方基于注入时钟计算。 */
export interface ApprovalRequestInput {
  approvalId: string;
  runId: string;
  requestId: string;
  traceId: string;
  userId: string;
  toolName?: string;
  permissionLevel?: ToolPermissionLevelDto;
  reason?: string;
  reasonCode?: string;
  inputDigest: string;
  inputPreview?: unknown;
  requestedAt: string;
  expiresAt: string;
}

/** 人工决定输入；reviewer 必须等于审批归属用户，身份只能来自服务端 session。 */
export interface ApprovalDecisionInput {
  approvalId: string;
  runId: string;
  reviewerUserId: string;
  decision: ToolApprovalDecisionValueDto;
  expectedInputDigest: string;
  reviewerNote?: string;
  decidedAt: string;
}

export type ApprovalDecideFailureCode = "not_found" | "conflict" | "expired";

/** conflict 细分：digest 绑定不符（重放/挪用尝试）或已存在不同决定。 */
export type ApprovalDecideConflictReason = "digest" | "decision";

export type ApprovalDecideResult =
  | { ok: true; idempotent: boolean; record: ApprovalRecord }
  | { ok: false; code: ApprovalDecideFailureCode; conflictReason?: ApprovalDecideConflictReason; record?: ApprovalRecord };

export type ApprovalRepositoryErrorCode = "conflict" | "not_found" | "database_unavailable";

/**
 * Approval repository 边界的结构化错误；不泄漏底层数据库异常细节。
 */
export class ApprovalRepositoryError extends Error {
  readonly code: ApprovalRepositoryErrorCode;

  /**
   * @param code 稳定的领域错误码。
   * @param message 可安全记录或映射的消息。
   * @param cause 仅供内部诊断的原始异常。
   */
  constructor(code: ApprovalRepositoryErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApprovalRepositoryError";
    this.code = code;
  }
}

/**
 * 工具权限领域的 Approval repository port。
 *
 * 所有方法把 user 归属作为强制谓词，不能只凭 approval ID 定位资源；
 * adapter 由 `@aiagent/database`（PostgreSQL）或测试内存实现提供。
 */
export interface ApprovalRepository {
  /**
   * 登记审批请求；对相同 approval id + input digest 幂等。
   *
   * @param input 审批请求与归属信息。
   * @returns 新建或已存在的审批记录。
   * @throws ApprovalRepositoryError 相同 id 但 digest/run/user 不一致时抛出 conflict。
   */
  requestApproval(input: ApprovalRequestInput): Promise<ApprovalRecord>;

  /**
   * 以 CAS 写入人工决定：仅当记录属于 reviewer、digest 匹配、处于 pending 且未过期时生效。
   *
   * 相同决定重试幂等返回既有记录；不同决定或 digest 不符返回 conflict；
   * 不存在或归属不符统一返回 not_found，不泄漏资源是否存在；
   * 过期 pending 先原子转为 expired 再返回 expired。
   *
   * @param input 决定内容与绑定校验。
   * @returns 决定结果。
   */
  decide(input: ApprovalDecisionInput): Promise<ApprovalDecideResult>;

  /**
   * 查询当前用户已批准的审批决定，供 PDF 导出等 gate 使用；过期记录一律排除。
   *
   * @param userId 当前用户标识。
   * @param approvalId 审批标识。
   * @returns 已批准且未过期的记录，否则 undefined。
   */
  findApprovedDecision(userId: string, approvalId: string): Promise<ApprovalRecord | undefined>;
}
