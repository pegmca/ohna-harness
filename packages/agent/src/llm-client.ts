import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmJsonChatRequest,
  LlmJsonChatResponse,
  LlmResult,
  LlmStreamEvent,
  LlmToolChatRequest,
  LlmToolChatResponse
} from "@aiagent/types";
import { normalizeConfig, type NormalizedLlmClientConfig, type TraceableLlmClientConfig } from "./llm/config.js";
import { requestChatCompletion } from "./llm/transport.js";
import { parseChatResponse, parseJsonObject, parseSseStream } from "./llm/parsing.js";
import { mapToolChoice } from "./llm/mapping.js";
import { traceModelCall } from "./llm/tracing.js";

/**
 * 使用显式配置创建统一 LLM client，并把供应商配置固定在 client 闭包中。
 *
 * @param config 调用 OpenAI compatible provider 所需的配置。
 * @returns 隐藏供应商 HTTP 细节的 LLM client。
 */
export function createLlmClient(config: TraceableLlmClientConfig): LlmClient {
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

/**
 * 普通 chat 只负责完成一次供应商调用，并把响应归一化为稳定的 LLM contract。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的普通 chat 请求。
 * @returns 成功时返回归一化 chat 响应，失败时返回结构化错误。
 */
async function chat(config: NormalizedLlmClientConfig, request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>> {
  return traceModelCall(config, "chat", () => chatCore(config, request));
}

/**
 * 执行普通 chat 的核心逻辑，供 jsonChat 复用而不重复写入 trace。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的普通 chat 请求。
 * @returns 成功时返回归一化 chat 响应，失败时返回结构化错误。
 */
async function chatCore(config: NormalizedLlmClientConfig, request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>> {
  const response = await requestChatCompletion(config, request);
  if (!response.ok) {
    return response;
  }

  return parseChatResponse(response.data, config.model);
}

/**
 * 流式 chat 复用同一套请求配置，只把 provider 的 SSE body 转换成内部流事件。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的流式 chat 请求。
 * @returns 成功时返回内部流事件迭代器，失败时返回结构化错误。
 */
async function streamChat(
  config: NormalizedLlmClientConfig,
  request: LlmChatRequest
): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>> {
  return traceModelCall(config, "stream_chat", () => streamChatCore(config, request));
}

/**
 * 执行流式 chat 的核心逻辑，trace wrapper 只记录建立请求阶段的结构化结果。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的流式 chat 请求。
 * @returns 成功时返回内部流事件迭代器，失败时返回结构化错误。
 */
async function streamChatCore(
  config: NormalizedLlmClientConfig,
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

/**
 * JSON chat 在普通 chat 之上增加解析层，解析失败也保持 LlmResult 结构化返回。
 *
 * @template TJson 期望从模型输出中解析出的 JSON 数据类型。
 * @param config 已归一化的 LLM client 配置。
 * @param request 带可选 schema 名称的 JSON chat 请求。
 * @returns 成功时返回原始 chat 响应和解析后的 JSON，失败时返回结构化错误。
 */
async function jsonChat<TJson = unknown>(
  config: NormalizedLlmClientConfig,
  request: LlmJsonChatRequest
): Promise<LlmResult<LlmJsonChatResponse<TJson>>> {
  return traceModelCall(config, "json_chat", async () => {
    const chatResult = await chatCore(config, request);
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
            // 预览内容限制长度，便于 trace 排障，同时避免保存完整模型输出。
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
  });
}

/**
 * Tool chat 将内部工具定义映射为 OpenAI compatible function tool，并归一化模型返回的 tool call。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 包含工具定义和 tool choice 的 chat 请求。
 * @returns 成功时返回模型选择的工具调用，失败时返回结构化错误。
 */
async function toolChat(
  config: NormalizedLlmClientConfig,
  request: LlmToolChatRequest
): Promise<LlmResult<LlmToolChatResponse>> {
  return traceModelCall(config, "tool_chat", () => toolChatCore(config, request));
}

/**
 * 执行 tool chat 的核心逻辑，解析失败保持结构化错误并交给 wrapper 写 trace。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 包含工具定义和 tool choice 的 chat 请求。
 * @returns 成功时返回模型选择的工具调用，失败时返回结构化错误。
 */
async function toolChatCore(
  config: NormalizedLlmClientConfig,
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
