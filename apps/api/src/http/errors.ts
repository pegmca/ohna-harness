import { ConversationRepositoryError } from "@aiagent/conversation";
import type { RagStructuredError } from "@aiagent/rag";
import { redactSensitiveValue } from "@aiagent/trace";
import type { ApiError, ApiResult } from "@aiagent/types";
import type { FastifyReply } from "fastify";

/**
 * 构造 API 失败结构，避免把原始异常对象直接返回给浏览器。
 *
 * @param error 结构化 API 错误。
 * @param requestId API 请求标识。
 * @returns ApiResult 失败分支。
 */
export function fail<TData>(error: ApiError, requestId: string): ApiResult<TData> {
  return {
    ok: false,
    error,
    requestId
  };
}

/**
 * 将 Conversation repository 错误映射到稳定 HTTP 错误，不泄漏数据库 cause。
 *
 * @param reply Fastify 响应。
 * @param requestId API 请求标识。
 * @param error 未知应用边界错误。
 * @returns 结构化失败结果。
 */
export function conversationFailure<TData>(
  reply: FastifyReply,
  requestId: string,
  error: unknown
): ApiResult<TData> {
  if (error instanceof ConversationRepositoryError) {
    if (error.code === "not_found") {
      reply.code(404);
      return fail(toApiError("not_found", "会话不存在。", requestId), requestId);
    }
    if (error.code === "invalid_cursor") {
      reply.code(400);
      return fail(toApiError("bad_request", "分页游标无效。", requestId), requestId);
    }
    if (error.code === "conflict") {
      reply.code(409);
      return fail(toApiError("conflict", "会话请求与已有数据冲突。", requestId), requestId);
    }
  }
  reply.code(503);
  return fail(toApiError("internal_error", "会话服务暂时不可用。", requestId), requestId);
}

/** @param reply Fastify 响应。 @param requestId API 请求标识。 @returns 未注入 repository 时的结构化错误。 */
export function unavailableConversation<TData>(reply: FastifyReply, requestId: string): ApiResult<TData> {
  reply.code(503);
  return fail(toApiError("internal_error", "会话服务未配置。", requestId), requestId);
}

/**
 * 构造稳定 API 错误对象。
 *
 * @param code API 错误码。
 * @param message 用户可读错误。
 * @param requestId API 请求标识。
 * @param details 可选诊断信息。
 * @returns ApiError。
 */
export function toApiError(
  code: ApiError["code"],
  message: string,
  requestId: string,
  details?: Record<string, unknown>
): ApiError {
  return {
    code,
    message,
    requestId,
    details: details ? redactSensitiveValue(details) : undefined
  };
}

/**
 * 把 RAG runtime 的结构化错误映射成 API 边界错误。
 *
 * @param error RAG runtime 错误。
 * @param requestId API 请求标识。
 * @returns 前端可消费的 ApiError。
 */
export function toApiErrorFromRagError(error: RagStructuredError, requestId: string): ApiError {
  const code: ApiError["code"] =
    error.code === "ingestion_failed" ||
    error.code === "invalid_chunking_options" ||
    error.code === "invalid_retrieval_options" ||
    error.code === "invalid_vector_search_options"
      ? "validation_failed"
      : "internal_error";

  return toApiError(code, error.message, requestId, {
    ragCode: error.code,
    ...error.details
  });
}

/**
 * 把 RAG runtime 错误映射成 HTTP 状态码。
 *
 * provider 未配置（`embedding_provider_disabled`）属于"服务端尚未具备能力"，语义上是 503 而不是 400：
 * 请求本身格式正确、重试不解决，只有组合根补上 provider 配置才恢复。其它 RAG 错误保持 400
 * （输入/状态不被接受），错误码本体已放进 details.ragCode，可诊断性不受状态码影响。
 *
 * @param error RAG runtime 错误。
 * @returns 应返回的 HTTP 状态码。
 */
export function ragErrorStatusCode(error: RagStructuredError): number {
  return error.code === "embedding_provider_disabled" ? 503 : 400;
}

/**
 * 生成 API adapter 自己的请求标识，和 Agent trace request id 分层展示。
 *
 * @returns 带 api_req_ 前缀的请求标识。
 */
export function createRequestId(): string {
  return `api_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
