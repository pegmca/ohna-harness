import type { RequestId } from "./primitives.js";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation_failed"
  | "agent_failed"
  | "tool_failed"
  | "trace_failed"
  | "request_cancelled"
  | "run_interrupted"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  requestId?: RequestId;
  details?: Record<string, unknown>;
}

export interface ApiSuccess<TData> {
  ok: true;
  data: TData;
  requestId: RequestId;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  requestId: RequestId;
}

export type ApiResult<TData> = ApiSuccess<TData> | ApiFailure;

export interface CursorPageDto<TItem> {
  items: TItem[];
  nextCursor?: string;
}
