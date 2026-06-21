export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface LlmChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmChatRequest extends LlmChatOptions {
  messages: LlmMessage[];
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmChatResponse {
  content: string;
  model: string;
  finishReason?: string;
  usage?: LlmUsage;
  toolCalls?: LlmToolCall[];
}

export type LlmErrorCode =
  | "configuration_error"
  | "request_timeout"
  | "network_error"
  | "provider_error"
  | "invalid_provider_response"
  | "json_parse_error"
  | "tool_parse_error";

export interface LlmError {
  code: LlmErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type LlmResult<T> = { ok: true; data: T } | { ok: false; error: LlmError };

export interface LlmJsonChatRequest extends LlmChatRequest {
  schemaName?: string;
}

export interface LlmJsonChatResponse<TJson = unknown> extends LlmChatResponse {
  json: TJson;
}

export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolChatRequest extends LlmChatRequest {
  tools: LlmToolDefinition[];
  toolChoice?: "auto" | "required" | { name: string };
}

export interface LlmToolChatResponse extends LlmChatResponse {
  toolCall: LlmToolCall;
}

export type LlmStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "done"; finishReason?: string };

export interface LlmClient {
  chat(request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>>;
  streamChat(request: LlmChatRequest): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>>;
  jsonChat<TJson = unknown>(request: LlmJsonChatRequest): Promise<LlmResult<LlmJsonChatResponse<TJson>>>;
  toolChat(request: LlmToolChatRequest): Promise<LlmResult<LlmToolChatResponse>>;
}
