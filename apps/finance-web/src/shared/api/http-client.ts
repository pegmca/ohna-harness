import type { ApiError, ApiResult } from "@aiagent/types";

/**
 * 将 fetch 响应收窄为统一 ApiResult，保证 HTML、空响应和代理故障不会泄漏原始异常。
 *
 * @param response 浏览器 fetch 响应。
 * @returns 可由 feature 稳定消费的结构化结果。
 */
export async function parseApiResult<TData>(response: Response): Promise<ApiResult<TData>> {
  const text = await response.text();
  const requestId = response.headers.get("x-request-id") ?? "unknown";

  if (!text.trim()) {
    return failure(
      requestId,
      response.ok ? "API 返回了空响应。" : `API 服务不可用：HTTP ${response.status}。`,
      { status: response.status, statusText: response.statusText }
    );
  }

  try {
    return JSON.parse(text) as ApiResult<TData>;
  } catch {
    return failure(requestId, `API 返回了非 JSON 响应：HTTP ${response.status}。`, {
      status: response.status,
      contentType: response.headers.get("content-type"),
      preview: text.slice(0, 240)
    });
  }
}

/**
 * 格式化结构化错误，只展示经过 API 边界允许的诊断字段。
 *
 * @param error API 错误。
 * @returns 用户可读错误文案。
 */
export function formatApiError(error: ApiError): string {
  const diagnostics = [
    typeof error.details?.status === "number" ? `status=${error.details.status}` : undefined,
    typeof error.details?.cause === "string" ? `cause=${error.details.cause}` : undefined
  ].filter(Boolean);
  return diagnostics.length ? `${error.code}: ${error.message} (${diagnostics.join(", ")})` : `${error.code}: ${error.message}`;
}

/**
 * 创建网络边界内部错误。
 *
 * @param requestId 请求标识。
 * @param message 安全错误文案。
 * @param details 可公开诊断信息。
 * @returns ApiResult 失败分支。
 */
function failure<TData>(requestId: string, message: string, details?: Record<string, unknown>): ApiResult<TData> {
  return {
    ok: false,
    requestId,
    error: { code: "internal_error", message, requestId, details }
  };
}
