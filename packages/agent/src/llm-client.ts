import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmClientConfig,
  LlmJsonChatRequest,
  LlmJsonChatResponse,
  LlmMessage,
  LlmResult,
  LlmRole,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolChatRequest,
  LlmToolChatResponse
} from "@aiagent/types";

interface OpenAiCompatibleChatMessage {
  role: LlmRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
}

interface OpenAiCompatibleToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiCompatibleChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAiCompatibleToolCall[];
  };
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAiCompatibleChatResponse {
  model?: string;
  choices?: OpenAiCompatibleChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const normalized = normalizeConfig(config);

  return {
    chat(request) {
      return chat(normalized, request);
    },
    streamChat(request) {
      return streamChat(normalized, request);
    },
    jsonChat<TJson = unknown>(request: LlmJsonChatRequest) {
      return jsonChat<TJson>(normalized, request);
    },
    toolChat(request) {
      return toolChat(normalized, request);
    }
  };
}

export function createLlmClientFromEnv(env: Record<string, string | undefined> = getDefaultEnv()): LlmResult<LlmClient> {
  const apiKey = env.AIAGENT_LLM_API_KEY ?? env.OPENAI_API_KEY;
  const baseUrl = env.AIAGENT_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  const model = env.AIAGENT_LLM_MODEL ?? env.OPENAI_MODEL;
  const timeoutValue = env.AIAGENT_LLM_TIMEOUT_MS;
  const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);

  if (!apiKey) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: "Missing LLM API key. Set AIAGENT_LLM_API_KEY or OPENAI_API_KEY."
      }
    };
  }

  if (!model) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: "Missing LLM model. Set AIAGENT_LLM_MODEL or OPENAI_MODEL."
      }
    };
  }

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: "AIAGENT_LLM_TIMEOUT_MS must be a positive number.",
        details: { timeoutValue }
      }
    };
  }

  return {
    ok: true,
    data: createLlmClient({ apiKey, baseUrl, model, timeoutMs })
  };
}

function normalizeConfig(config: LlmClientConfig): Required<LlmClientConfig> {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: config.fetch ?? fetch
  };
}

function getDefaultEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

async function chat(config: Required<LlmClientConfig>, request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>> {
  const response = await requestChatCompletion(config, request);
  if (!response.ok) {
    return response;
  }

  return parseChatResponse(response.data, config.model);
}

async function streamChat(
  config: Required<LlmClientConfig>,
  request: LlmChatRequest
): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>> {
  const response = await requestChatCompletion(config, request, { stream: true });
  if (!response.ok) {
    return response;
  }

  if (!response.data.body) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider did not return a readable stream."
      }
    };
  }

  return {
    ok: true,
    data: parseSseStream(response.data.body)
  };
}

async function jsonChat<TJson = unknown>(
  config: Required<LlmClientConfig>,
  request: LlmJsonChatRequest
): Promise<LlmResult<LlmJsonChatResponse<TJson>>> {
  const chatResult = await chat(config, request);
  if (!chatResult.ok) {
    return chatResult;
  }

  const parseResult = parseJsonObject<TJson>(chatResult.data.content);
  if (!parseResult.ok) {
    return {
      ok: false,
      error: {
        code: "json_parse_error",
        message: `Failed to parse ${request.schemaName ?? "model"} JSON output.`,
        details: {
          reason: parseResult.error,
          contentPreview: chatResult.data.content.slice(0, 500)
        }
      }
    };
  }

  return {
    ok: true,
    data: {
      ...chatResult.data,
      json: parseResult.data
    }
  };
}

async function toolChat(
  config: Required<LlmClientConfig>,
  request: LlmToolChatRequest
): Promise<LlmResult<LlmToolChatResponse>> {
  const response = await requestChatCompletion(config, request, {
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    })),
    tool_choice: mapToolChoice(request.toolChoice)
  });

  if (!response.ok) {
    return response;
  }

  const chatResult = await parseChatResponse(response.data, config.model);
  if (!chatResult.ok) {
    return chatResult;
  }

  const [toolCall] = chatResult.data.toolCalls ?? [];
  if (!toolCall) {
    return {
      ok: false,
      error: {
        code: "tool_parse_error",
        message: "Model response did not include a tool call.",
        details: {
          contentPreview: chatResult.data.content.slice(0, 500)
        }
      }
    };
  }

  return {
    ok: true,
    data: {
      ...chatResult.data,
      toolCall
    }
  };
}

async function requestChatCompletion(
  config: Required<LlmClientConfig>,
  request: LlmChatRequest,
  extraBody: Record<string, unknown> = {}
): Promise<LlmResult<Response>> {
  const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await config.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: request.messages.map(mapMessage),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...extraBody
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        error: await parseProviderError(response)
      };
    }

    return { ok: true, data: response };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        error: {
          code: "request_timeout",
          message: `LLM request timed out after ${timeoutMs}ms.`,
          details: { timeoutMs }
        }
      };
    }

    return {
      ok: false,
      error: {
        code: "network_error",
        message: "LLM request failed before receiving a provider response.",
        details: { reason: getErrorMessage(error) }
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function parseChatResponse(response: Response, fallbackModel: string): Promise<LlmResult<LlmChatResponse>> {
  const jsonResult = await parseResponseJson<OpenAiCompatibleChatResponse>(response);
  if (!jsonResult.ok) {
    return jsonResult;
  }

  const payload = jsonResult.data;
  const [choice] = payload.choices ?? [];
  if (!choice?.message) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider response did not include a chat message.",
        details: { payload }
      }
    };
  }

  const toolCallsResult = parseToolCalls(choice.message.tool_calls ?? []);
  if (!toolCallsResult.ok) {
    return toolCallsResult;
  }

  return {
    ok: true,
    data: {
      content: choice.message.content ?? "",
      model: payload.model ?? fallbackModel,
      finishReason: choice.finish_reason ?? undefined,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens
          }
        : undefined,
      toolCalls: toolCallsResult.data.length > 0 ? toolCallsResult.data : undefined
    }
  };
}

async function parseProviderError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => undefined);
    const providerError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    return {
      code: "provider_error" as const,
      message:
        typeof providerError?.message === "string"
          ? providerError.message
          : `LLM provider returned HTTP ${response.status}.`,
      details: {
        status: response.status,
        type: typeof providerError?.type === "string" ? providerError.type : undefined,
        providerCode: typeof providerError?.code === "string" ? providerError.code : undefined
      }
    };
  }

  return {
    code: "provider_error" as const,
    message: `LLM provider returned HTTP ${response.status}.`,
    details: {
      status: response.status,
      bodyPreview: (await response.text().catch(() => "")).slice(0, 500)
    }
  };
}

async function parseResponseJson<T>(response: Response): Promise<LlmResult<T>> {
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider response was not valid JSON.",
        details: { reason: getErrorMessage(error) }
      }
    };
  }
}

function parseToolCalls(toolCalls: OpenAiCompatibleToolCall[]): LlmResult<LlmToolCall[]> {
  const parsed: LlmToolCall[] = [];

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name;
    if (!name) {
      return {
        ok: false,
        error: {
          code: "tool_parse_error",
          message: "Tool call response was missing a function name.",
          details: { toolCall }
        }
      };
    }

    const argumentsText = toolCall.function?.arguments ?? "{}";
    const argumentsResult = parseJsonObject<Record<string, unknown>>(argumentsText);
    if (!argumentsResult.ok || !isRecord(argumentsResult.data)) {
      return {
        ok: false,
        error: {
          code: "tool_parse_error",
          message: `Tool call arguments for ${name} were not valid JSON object.`,
          details: {
            reason: argumentsResult.ok ? "Parsed value is not an object." : argumentsResult.error,
            argumentsPreview: argumentsText.slice(0, 500)
          }
        }
      };
    }

    parsed.push({
      id: toolCall.id,
      name,
      arguments: argumentsResult.data
    });
  }

  return { ok: true, data: parsed };
}

function parseJsonObject<T>(content: string): { ok: true; data: T } | { ok: false; error: string } {
  const trimmed = content.trim();
  const jsonText = trimmed.startsWith("```") ? stripJsonFence(trimmed) : trimmed;

  try {
    return { ok: true, data: JSON.parse(jsonText) as T };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

function stripJsonFence(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<LlmStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          continue;
        }

        const eventResult = parseStreamPayload(data);
        if (eventResult.ok) {
          for (const event of eventResult.data) {
            yield event;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseStreamPayload(payload: string): LlmResult<LlmStreamEvent[]> {
  const jsonResult = parseJsonObject<OpenAiCompatibleChatResponse>(payload);
  if (!jsonResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Streaming response chunk was not valid JSON.",
        details: { reason: jsonResult.error, payloadPreview: payload.slice(0, 500) }
      }
    };
  }

  const events: LlmStreamEvent[] = [];
  const [choice] = jsonResult.data.choices ?? [];
  const content = choice?.delta?.content;
  if (content) {
    events.push({ type: "content_delta", delta: content });
  }

  for (const toolCall of choice?.delta?.tool_calls ?? []) {
    events.push({
      type: "tool_call_delta",
      index: toolCall.index ?? 0,
      id: toolCall.id,
      name: toolCall.function?.name,
      argumentsDelta: toolCall.function?.arguments
    });
  }

  if (choice?.finish_reason) {
    events.push({ type: "done", finishReason: choice.finish_reason });
  }

  return { ok: true, data: events };
}

function mapMessage(message: LlmMessage): OpenAiCompatibleChatMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId
  };
}

function mapToolChoice(choice: LlmToolChatRequest["toolChoice"]): unknown {
  if (!choice) {
    return undefined;
  }

  if (choice === "auto" || choice === "required") {
    return choice;
  }

  return {
    type: "function",
    function: {
      name: choice.name
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
