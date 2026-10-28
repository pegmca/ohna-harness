import { GoldenStudioError } from "../core/errors.js";
import { WorkspaceError } from "../core/workspace.js";

/** server 边界自身产生的稳定错误码。 */
export type HttpErrorCode =
  | "not_found"
  | "method_not_allowed"
  | "invalid_json"
  | "request_too_large"
  | "invalid_request"
  | "confirmation_required"
  | "range_not_satisfiable"
  | "internal_error";

/** server 路由边界的可序列化错误。 */
export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  /**
   * @param status HTTP 状态码。
   * @param code 稳定错误码。
   * @param message 可展示的说明。
   * @param details 机器可读详情。
   */
  constructor(
    status: number,
    code: HttpErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 统一错误响应形状。 */
export interface ErrorEnvelope {
  ok: false;
  error: {
    status: number;
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

/**
 * 把 core 与 route 错误映射为稳定的 HTTP 错误信封。
 *
 * @param error 捕获的异常。
 * @returns HTTP 状态与统一信封。
 */
export function toErrorEnvelope(error: unknown): {
  status: number;
  body: ErrorEnvelope;
} {
  if (error instanceof HttpError) {
    return envelope(error.status, error.code, error.message, error.details);
  }
  if (error instanceof WorkspaceError) {
    return envelope(workspaceStatus(error.code), error.code, error.message, details(error));
  }
  if (error instanceof GoldenStudioError) {
    return envelope(studioStatus(error.code), error.code, error.message, error.details);
  }
  return envelope(
    500,
    "internal_error",
    "The local server could not complete the request.",
    {}
  );
}

/**
 * 构造统一错误响应体。
 *
 * @param status HTTP 状态。
 * @param code 稳定错误码。
 * @param message 可展示消息。
 * @param errorDetails 机器可读详情。
 * @returns 错误信封。
 */
function envelope(
  status: number,
  code: string,
  message: string,
  errorDetails: Record<string, unknown>
): { status: number; body: ErrorEnvelope } {
  return {
    status,
    body: {
      ok: false,
      error: { status, code, message, details: errorDetails }
    }
  };
}

/**
 * 映射工作区错误为 HTTP 状态。
 *
 * @param code 工作区错误码。
 * @returns HTTP 状态码。
 */
function workspaceStatus(code: WorkspaceError["code"]): number {
  switch (code) {
    case "path_outside_root":
    case "invalid_batch_name":
    case "invalid_draft_id":
      return 400;
    case "workspace_config_missing":
    case "manifest_not_found":
    case "invalid_root_path":
      return 503;
  }
}

/**
 * 映射核心草稿错误为 HTTP 状态。
 *
 * @param code 核心错误码。
 * @returns HTTP 状态码。
 */
function studioStatus(code: GoldenStudioError["code"]): number {
  switch (code) {
    case "draft_not_found":
    case "drafts_not_found":
    case "evidence_not_found":
      return 404;
    case "draft_corrupt":
    case "evidence_parse_failed":
      return 409;
    case "atomic_write_failed":
    case "backup_failed":
      return 500;
  }
}

/**
 * 仅提取已知错误的可序列化详情。
 *
 * @param error 工作区或草稿错误。
 * @returns 错误详情对象。
 */
function details(error: WorkspaceError | GoldenStudioError): Record<string, unknown> {
  if (error instanceof GoldenStudioError) return error.details;
  return {};
}
