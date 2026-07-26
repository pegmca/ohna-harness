import type { LlmChatRequest, LlmResult } from "@aiagent/types";
import { DEFAULT_TIMEOUT_MS, type NormalizedLlmClientConfig } from "./config.js";
import { getErrorMessage, isAbortError, isRecord } from "./utils.js";
import { mapMessage } from "./mapping.js";

/**
 * 构造并发送 OpenAI compatible chat completions 请求，统一处理 HTTP 错误、网络错误和超时。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的 chat 请求。
 * @param extraBody 仅特定调用模式需要追加的 provider body 字段。
 * @returns 成功时返回原始 Response，失败时返回结构化错误。
 */
export async function requestChatCompletion(
  config: NormalizedLlmClientConfig,
  request: LlmChatRequest,
  extraBody: Record<string, unknown> = {}
): Promise<LlmResult<Response>> {
  const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // 普通请求和流式请求共用 AbortController 作为唯一超时机制。
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await config.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildRequestHeaders(config),
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
        // 未知异常在跨出 agent 边界前统一转换为结构化数据。
        details: { reason: getErrorMessage(error) }
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 构造 provider 请求头，并在配置存在时带上 Claude Code 兼容的会话归因字段。
 *
 * @param config 已归一化的 LLM client 配置。
 * @returns 发送给 OpenAI compatible provider 的 HTTP headers。
 */
function buildRequestHeaders(config: NormalizedLlmClientConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json"
  };
}

/**
 * 解析 provider 的 HTTP 错误响应，尽量保留可观测诊断字段。
 *
 * @param response provider 返回的非 2xx HTTP 响应。
 * @returns provider_error 结构化错误。
 */
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
        // 保留供应商诊断字段用于可观测性，但不把原始响应体暴露给调用方。
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

/**
 * 安全解析 HTTP JSON 响应，避免 JSON.parse 异常穿透到调用方。
 *
 * @template T 期望的 JSON payload 类型。
 * @param response provider 返回的 HTTP 响应。
 * @returns 成功时返回 JSON payload，失败时返回 invalid_provider_response。
 */
export async function parseResponseJson<T>(response: Response): Promise<LlmResult<T>> {
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
