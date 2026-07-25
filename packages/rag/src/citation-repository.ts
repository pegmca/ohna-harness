/**
 * Citation 持久化 port。
 *
 * Citation 是生成物（assistant message / report artifact）与固定文档版本/chunk 之间的证据链接：
 * 写入发生在生成物保存的同一事务内（由 PostgreSQL adapter 封闭跨表原子性），
 * 读取必须先验证生成物归属用户，再按当前文档 scope 投影可访问来源。
 * quote 是生成时快照，用于来源归档后仍可解释，但不替代 chunk/version 外键。
 */

/** 校验状态：unverified 待校验；verified/rejected 自动校验终态；manual_* 人工终态，不可被自动覆盖。 */
export type CitationVerifierStatus = "unverified" | "verified" | "rejected" | "manual_verified" | "manual_rejected";

/**
 * 写入单条 citation 的输入。
 *
 * chunkId 是持久化 chunk 的域 id（createPersistentChunkId 派生），adapter 据此解析
 * chunk/version 外键；无法解析（如非 RAG 来源）时外键为空，仅保留 quote 快照。
 */
export interface NewCitationInput {
  ordinal: number;
  chunkId?: string;
  claim: string;
  quote: string;
  score?: number;
  verifierStatus?: CitationVerifierStatus;
}

/** 来源可访问时的投影：包含 chunk/version 回链、source URI 与 quote 快照。 */
export interface AccessibleCitationSource {
  status: "accessible";
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  sourceUri: string;
  heading?: string;
  chunkIndex: number;
  quote: string;
  score?: number;
}

/** 来源不可访问（文档已删除或对当前用户不可见）：不返回正文快照与 source URI。 */
export interface InaccessibleCitationSource {
  status: "inaccessible";
}

/** 写入时无法解析到持久化 chunk/version：仅有生成时 quote 快照，无回链。 */
export interface UnresolvedCitationSource {
  status: "unresolved";
  quote: string;
  score?: number;
}

export type CitationSourceProjection = AccessibleCitationSource | InaccessibleCitationSource | UnresolvedCitationSource;

/** 读取侧 citation 记录：序号在来源不可访问时仍保持稳定。 */
export interface CitationRecord {
  citationId: string;
  ordinal: number;
  claim: string;
  verifierStatus: CitationVerifierStatus;
  createdAt: string;
  source: CitationSourceProjection;
}

/** verifier 状态更新结果：显式区分未找到与非法迁移，不用异常表达业务结果。 */
export type CitationVerifierUpdateResult =
  | { status: "updated"; verifierStatus: CitationVerifierStatus }
  | { status: "not_found" }
  | { status: "invalid_transition"; current: CitationVerifierStatus };

/**
 * 判断 verifier 状态迁移是否合法。
 *
 * - 人工终态（manual_*）不可被任何更新覆盖；
 * - 自动终态（verified/rejected）只允许人工覆盖，不允许自动结果之间互改；
 * - unverified 可迁移到任意状态。
 *
 * @param current 当前状态。
 * @param next 目标状态。
 * @returns 合法返回 true。
 */
export function canTransitionCitationVerifierStatus(current: CitationVerifierStatus, next: CitationVerifierStatus): boolean {
  if (current === next) return true;
  if (current === "unverified") return true;
  if (current === "verified" || current === "rejected") {
    return next === "manual_verified" || next === "manual_rejected";
  }
  return false;
}

/**
 * Citation repository port。
 *
 * 所有方法从签名上强制 userId 归属：先验证生成物属于该用户，再返回/更新引用，
 * 不存在或越权时读取返回 undefined、更新返回 not_found，不区分两种原因以避免资源探测。
 */
export interface CitationRepository {
  /**
   * 按序号稳定列出 assistant message 的引用，按当前文档 scope 投影来源可访问性。
   *
   * @param userId 服务端确认的用户 ID。
   * @param messageId assistant message ID。
   * @returns 引用数组；消息不存在或不属于该用户时返回 undefined。
   */
  listMessageCitations(userId: string, messageId: string): Promise<CitationRecord[] | undefined>;

  /**
   * 按序号稳定列出 report artifact 的引用，按当前文档 scope 投影来源可访问性。
   *
   * @param userId 服务端确认的用户 ID。
   * @param artifactId artifact ID。
   * @returns 引用数组；artifact 不存在、已删除或不属于该用户时返回 undefined。
   */
  listArtifactCitations(userId: string, artifactId: string): Promise<CitationRecord[] | undefined>;

  /**
   * 以显式状态迁移更新 message citation 的校验状态，不覆盖人工/终态结果。
   *
   * @param userId 服务端确认的用户 ID。
   * @param citationId 引用记录 ID。
   * @param next 目标校验状态。
   * @returns 更新结果；非法迁移返回当前状态。
   */
  updateMessageCitationVerifierStatus(
    userId: string,
    citationId: string,
    next: CitationVerifierStatus
  ): Promise<CitationVerifierUpdateResult>;

  /**
   * 以显式状态迁移更新 artifact citation 的校验状态，不覆盖人工/终态结果。
   *
   * @param userId 服务端确认的用户 ID。
   * @param citationId 引用记录 ID。
   * @param next 目标校验状态。
   * @returns 更新结果；非法迁移返回当前状态。
   */
  updateArtifactCitationVerifierStatus(
    userId: string,
    citationId: string,
    next: CitationVerifierStatus
  ): Promise<CitationVerifierUpdateResult>;
}
