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
  /**
   * 调用方可以按 client 或单次请求覆盖默认超时，让 UI 路径可预测地失败。
   */
  timeoutMs?: number;
  /**
   * 注入 fetch 让供应商调用可测试，也避免应用层依赖底层 HTTP 细节。
   */
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
  /**
   * 稳定错误码是包边界之间的契约，供应商特有诊断信息只放在可选 details 中。
   */
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

/**
 * Client 边界向 agent 和 UI 调用方隐藏 OpenAI compatible 的请求/响应形状。
 */
export interface LlmClient {
  /**
   * 执行一次普通 chat 调用，并返回归一化后的模型文本、用量和可选工具调用。
   *
   * @param request 普通 chat 请求。
   * @returns 成功时返回 chat 响应，失败时返回结构化错误。
   */
  chat(request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>>;

  /**
   * 执行一次流式 chat 调用，并把供应商 SSE 数据转换为内部流事件。
   *
   * @param request 流式 chat 请求。
   * @returns 成功时返回异步事件迭代器，失败时返回结构化错误。
   */
  streamChat(request: LlmChatRequest): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>>;

  /**
   * 执行一次 chat 调用，并将模型输出解析为 JSON。
   *
   * @template TJson 期望解析出的 JSON 数据类型。
   * @param request JSON chat 请求。
   * @returns 成功时返回 chat 响应和解析后的 JSON，失败时返回结构化错误。
   */
  jsonChat<TJson = unknown>(request: LlmJsonChatRequest): Promise<LlmResult<LlmJsonChatResponse<TJson>>>;

  /**
   * 执行一次带工具定义的 chat 调用，并返回模型选择的工具调用。
   *
   * @param request 工具 chat 请求。
   * @returns 成功时返回归一化工具调用，失败时返回结构化错误。
   */
  toolChat(request: LlmToolChatRequest): Promise<LlmResult<LlmToolChatResponse>>;
}
