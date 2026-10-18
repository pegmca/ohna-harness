import type { IdentitySnapshot } from "@aiagent/identity";
import type { DataSourceRuntime } from "@aiagent/rag";
import type { ApiResult, RagAnswerResponseDto, RagSearchResponseDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, fail, ragErrorStatusCode, toApiError, toApiErrorFromRagError } from "../errors.js";
import { ragAnswerRequestSchema, ragSearchRequestSchema } from "../schemas.js";

export interface RagRoutesDeps {
  dataSourceRuntime: DataSourceRuntime;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 RAG search 与 answer 路由。
 *
 * @param app Fastify 实例。
 * @param deps RAG runtime 与共享 identity 映射。
 */
export function registerRagRoutes(app: FastifyInstance, deps: RagRoutesDeps): void {
  const { dataSourceRuntime, identityByRequest } = deps;

  /**
   * RAG search 接口执行混合检索，并把 runtime 检索结果映射为带 score、metadata 和 citation 的 DTO。
   *
   * @param request Fastify 请求对象，body 必须符合 RagSearchRequestDto。
   * @param reply Fastify 响应对象，用于在校验或检索失败时设置 HTTP 状态码。
   * @returns 成功时返回 retrieval results 和脱敏 retrieval trace。
   */
  app.post("/api/rag/search", async (request, reply): Promise<ApiResult<RagSearchResponseDto>> => {
    const requestId = createRequestId();
    const parsed = ragSearchRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "RAG search 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const result = await dataSourceRuntime.search(parsed.data.query.trim(), {
      topK: parsed.data.topK
    }, { ownerUserId: identityByRequest.get(request)?.userId ?? null });

    if (!result.ok) {
      reply.code(ragErrorStatusCode(result.error));
      return fail(toApiErrorFromRagError(result.error, requestId), requestId);
    }

    return {
      ok: true,
      data: result.data,
      requestId
    };
  });

  /**
   * RAG answer 接口基于检索证据生成 citation answer，并在证据不足时触发 unknown answer policy。
   *
   * @param request Fastify 请求对象，body 必须符合 RagAnswerRequestDto。
   * @param reply Fastify 响应对象，用于在校验或回答生成失败时设置 HTTP 状态码。
   * @returns 成功时返回带 citations 的 grounded answer 和 retrieval trace。
   */
  app.post("/api/rag/answer", async (request, reply): Promise<ApiResult<RagAnswerResponseDto>> => {
    const requestId = createRequestId();
    const parsed = ragAnswerRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "RAG answer 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const result = await dataSourceRuntime.answer(parsed.data.question.trim(), {
      topK: parsed.data.topK
    }, { ownerUserId: identityByRequest.get(request)?.userId ?? null });

    if (!result.ok) {
      reply.code(ragErrorStatusCode(result.error));
      return fail(toApiErrorFromRagError(result.error, requestId), requestId);
    }

    return {
      ok: true,
      data: result.data,
      requestId
    };
  });
}
