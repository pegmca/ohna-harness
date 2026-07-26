import type {
  LlmChatResponse,
  LlmResult,
  LlmRole,
  LlmStreamEvent,
  LlmToolCall
} from "@aiagent/types";
import { getErrorMessage, isRecord } from "./utils.js";
import { parseResponseJson } from "./transport.js";

export interface OpenAiCompatibleChatMessage {
  role: LlmRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
}

export interface OpenAiCompatibleToolCall {
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

/**
 * 解析 provider 的非流式 chat 响应，并转换为内部 LLM 响应结构。
 *
 * @param response provider 返回的原始 HTTP 响应。
 * @param fallbackModel provider 未返回 model 时使用的配置模型名。
 * @returns 成功时返回归一化响应，失败时返回结构化解析错误。
 */
export async function parseChatResponse(response: Response, fallbackModel: string): Promise<LlmResult<LlmChatResponse>> {
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

  // 在这里解析 tool calls，让 chat() 和 toolChat() 共享同一套供应商归一化逻辑。
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

/**
 * 解析 OpenAI compatible tool_calls，并验证函数名和参数对象形状。
 *
 * @param toolCalls provider 返回的 tool_calls 数组。
 * @returns 成功时返回内部工具调用列表，失败时返回 tool_parse_error。
 */
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
      // 工具参数必须是对象，后续工具执行才能按稳定形状做校验。
      arguments: argumentsResult.data
    });
  }

  return { ok: true, data: parsed };
}

/**
 * 解析模型输出中的 JSON，并兼容常见的 markdown fenced JSON。
 *
 * @template T 期望的 JSON 数据类型。
 * @param content 模型输出文本。
 * @returns 成功时返回解析结果，失败时返回错误原因字符串。
 */
export function parseJsonObject<T>(content: string): { ok: true; data: T } | { ok: false; error: string } {
  const trimmed = content.trim();
  // 模型经常用 markdown fence 包裹 JSON，client 边界直接兼容这种常见输出。
  const jsonText = trimmed.startsWith("```") ? stripJsonFence(trimmed) : trimmed;

  try {
    return { ok: true, data: JSON.parse(jsonText) as T };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * 去掉包裹 JSON 的 markdown fence，保留内部 JSON 文本。
 *
 * @param content 以 markdown fence 包裹的模型输出。
 * @returns 去除 fence 后的文本。
 */
function stripJsonFence(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * 解析 OpenAI compatible SSE 响应体，并逐条产出内部流事件。
 *
 * @param body provider 返回的可读字节流。
 * @returns 内部 LLM 流事件的异步迭代器。
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<LlmStreamEvent> {
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
      // SSE chunk 可能在网络读取中截断一行，所以把未完成的行留在 buffer 中。
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

/**
 * 解析单条 SSE data payload，并转换为一个或多个内部流事件。
 *
 * @param payload SSE data 行中的 JSON 字符串。
 * @returns 成功时返回流事件列表，失败时返回结构化解析错误。
 */
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
