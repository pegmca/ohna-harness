import type { IdentitySnapshot } from "@aiagent/identity";
import type { DataSourceRuntime } from "@aiagent/rag";
import type {
  ApiResult,
  DataSourceChunksResponseDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, fail, ragErrorStatusCode, toApiError, toApiErrorFromRagError } from "../errors.js";
import {
  dataSourceChunksQuerySchema,
  dataSourceDocumentsQuerySchema,
  dataSourceIngestRequestSchema
} from "../schemas.js";

export interface DataSourceRoutesDeps {
  dataSourceRuntime: DataSourceRuntime;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 Data Sources ingestion、文档列表与 chunk 列表路由。
 *
 * @param app Fastify 实例。
 * @param deps RAG runtime 与共享 identity 映射。
 */
export function registerDataSourceRoutes(app: FastifyInstance, deps: DataSourceRoutesDeps): void {
  const { dataSourceRuntime, identityByRequest } = deps;

  /**
   * Data Sources ingestion 接口负责接收 Markdown/TXT 文本，校验后交给 RAG runtime 完成解析、切块和索引。
   *
   * @param request Fastify 请求对象，body 必须符合 DataSourceIngestRequestDto。
   * @param reply Fastify 响应对象，用于在校验或 runtime 失败时设置 HTTP 状态码。
   * @returns 成功时返回 ingest 后的 document、chunks 和索引数量；失败时返回结构化 ApiResult。
   */
  app.post("/api/data-sources/ingest", async (request, reply): Promise<ApiResult<DataSourceIngestResponseDto>> => {
    const requestId = createRequestId();
    const parsed = dataSourceIngestRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "Data source ingest 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const result = await dataSourceRuntime.ingest(
      {
        source: parsed.data.source.trim(),
        fileName: parsed.data.fileName.trim(),
        contentType: parsed.data.contentType?.trim(),
        content: parsed.data.content
      },
      { ownerUserId: identityByRequest.get(request)?.userId ?? null }
    );

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
   * Data Sources 文档列表接口经 repository 分页读取，按 owner/scope 授权，API 层不保存业务状态。
   *
   * @param request Fastify 请求对象，query 支持 cursor 和 limit（默认 50，上限 100）。
   * @param reply Fastify 响应对象，用于参数校验或读取失败时设置 HTTP 状态码。
   * @returns 当前身份可见的文档摘要页和下一页 cursor。
   */
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/api/data-sources/documents",
    async (request, reply): Promise<ApiResult<DataSourceDocumentsResponseDto>> => {
      const requestId = createRequestId();
      const parsed = dataSourceDocumentsQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        reply.code(400);
        return fail(toApiError("validation_failed", "Data source documents 查询参数不正确。", requestId, {
          issues: parsed.error.issues
        }), requestId);
      }

      try {
        const page = await dataSourceRuntime.listDocuments({
          ownerUserId: identityByRequest.get(request)?.userId ?? null,
          ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
          limit: parsed.data.limit
        });
        return { ok: true, data: page, requestId };
      } catch {
        reply.code(500);
        return fail(toApiError("internal_error", "Data source documents 读取失败。", requestId), requestId);
      }
    }
  );

  /**
   * Data Sources chunk 列表接口分页返回可展示 chunk，不暴露 embedding 向量等内部索引字段。
   *
   * @param request Fastify 请求对象，query 支持 cursor、limit 和可选 documentId 过滤。
   * @param reply Fastify 响应对象，用于参数校验或读取失败时设置 HTTP 状态码。
   * @returns 当前身份可见的 chunk 页和下一页 cursor。
   */
  app.get<{ Querystring: { cursor?: string; limit?: string; documentId?: string } }>(
    "/api/data-sources/chunks",
    async (request, reply): Promise<ApiResult<DataSourceChunksResponseDto>> => {
      const requestId = createRequestId();
      const parsed = dataSourceChunksQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        reply.code(400);
        return fail(toApiError("validation_failed", "Data source chunks 查询参数不正确。", requestId, {
          issues: parsed.error.issues
        }), requestId);
      }

      try {
        const page = await dataSourceRuntime.listChunks({
          ownerUserId: identityByRequest.get(request)?.userId ?? null,
          ...(parsed.data.documentId !== undefined ? { documentId: parsed.data.documentId } : {}),
          ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
          limit: parsed.data.limit
        });
        return { ok: true, data: page, requestId };
      } catch {
        reply.code(500);
        return fail(toApiError("internal_error", "Data source chunks 读取失败。", requestId), requestId);
      }
    }
  );
}
