export type ISODateTimeString = string;

export type RequestId = string;

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

export type ResearchMode = "chat" | "report";

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: ISODateTimeString;
}

export interface AgentRunRequestDto {
  input: string;
  mode?: ResearchMode;
  conversationId?: string;
}

export interface AgentRunResponseDto {
  conversationId: string;
  message: ChatMessageDto;
  traceId?: string;
}
