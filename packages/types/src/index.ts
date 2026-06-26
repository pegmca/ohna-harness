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

export type AgentIntentDto = "chat" | "tool" | "report_skill";

export type AgentStepStatusDto = "succeeded" | "failed";

export interface AgentStepDto {
  index: number;
  type: string;
  status: AgentStepStatusDto;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: ApiError;
}

export interface TraceErrorDto {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TraceDto {
  traceId: string;
  requestId: string;
  startedAt: ISODateTimeString;
  events: TraceEventDto[];
}

export type TraceEventDto =
  | TraceRequestReceivedEventDto
  | TraceIntentRoutedEventDto
  | TraceAgentStepEventDto
  | TraceModelCallEventDto
  | TraceToolCallEventDto
  | TraceFinalResponseEventDto;

export interface TraceEventBaseDto {
  type: string;
  id: string;
  traceId: string;
  requestId: string;
  createdAt: ISODateTimeString;
}

export interface TraceRequestReceivedEventDto extends TraceEventBaseDto {
  type: "request_received";
  userMessage: string;
  inputPreview: string;
}

export interface TraceIntentRoutedEventDto extends TraceEventBaseDto {
  type: "intent_routed";
  intent: string;
  confidence: number;
  reason: string;
  toolName?: string;
}

export interface TraceAgentStepEventDto extends TraceEventBaseDto {
  type: "agent_step";
  stepIndex: number;
  stepType: string;
  status: "started" | "succeeded" | "failed";
  durationMs: number;
  data?: Record<string, unknown>;
  error?: TraceErrorDto;
}

export interface TraceModelCallEventDto extends TraceEventBaseDto {
  type: "model_call";
  model: string;
  purpose: string;
  durationMs: number;
  ok: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: TraceErrorDto;
}

export interface TraceToolCallEventDto extends TraceEventBaseDto {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  error?: TraceErrorDto;
}

export interface TraceFinalResponseEventDto extends TraceEventBaseDto {
  type: "final_response";
  answerPreview: string;
  ok: boolean;
  error?: TraceErrorDto;
}

export interface AgentRunRequestDto {
  message: string;
  reportMode?: boolean;
  conversationId?: string;
}

export interface AgentRunResponseDto {
  conversationId: string;
  requestId: string;
  traceId: string;
  ok: boolean;
  intent: AgentIntentDto;
  answer: string;
  steps: AgentStepDto[];
  trace: TraceDto;
  error?: ApiError;
}

export * from "./llm.js";
