import type { GoldenStudioErrorCode } from "./types.js";

/** Golden Studio 文件与草稿边界的可序列化结构化错误。 */
export class GoldenStudioError extends Error {
  readonly code: GoldenStudioErrorCode;
  readonly details: Record<string, unknown>;

  /**
   * @param code 稳定错误码。
   * @param message 可安全展示的错误说明。
   * @param details 供 CLI/HTTP 边界映射的上下文。
   * @param cause 仅供内部诊断的原始异常。
   */
  constructor(
    code: GoldenStudioErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "GoldenStudioError";
    this.code = code;
    this.details = details;
  }
}
