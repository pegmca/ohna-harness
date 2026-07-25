export type RepositoryErrorCode =
  | "conflict"
  | "not_found"
  | "database_unavailable"
  | "invalid_state_transition";

/**
 * Repository 边界的结构化错误。
 *
 * `cause` 仅供服务端诊断，API 映射时只应使用 code 与安全 message。
 */
export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  /**
   * @param code 稳定的领域错误码。
   * @param message 可安全记录或映射的消息。
   * @param cause 仅供内部诊断的原始异常。
   */
  constructor(code: RepositoryErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RepositoryError";
    this.code = code;
  }
}
