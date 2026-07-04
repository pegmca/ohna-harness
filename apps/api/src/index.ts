import { runAgent } from "@aiagent/agent";
import type { AgentResponse, AgentStep } from "@aiagent/agent";
import { createDataSourceRuntime } from "@aiagent/rag";
import type { RagStructuredError } from "@aiagent/rag";
import type {
  AgentRunRequestDto,
  AgentRunResponseDto,
  AgentStepDto,
  ApiError,
  ApiResult,
  DataSourceChunksResponseDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto,
  RagAnswerResponseDto,
  RagSearchResponseDto
} from "@aiagent/types";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const agentRunRequestSchema = z.object({
  message: z.string(),
  reportMode: z.boolean().optional(),
  conversationId: z.string().min(1).optional()
});
const dataSourceIngestRequestSchema = z.object({
  source: z.string().min(1),
  fileName: z.string().min(1),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1)
});
const ragSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().optional()
});
const ragAnswerRequestSchema = z.object({
  question: z.string().min(1),
  topK: z.number().int().positive().optional()
});

const DEFAULT_CONVERSATION_ID = "week1-local-session";

/**
 * 创建 Week 1 最小 HTTP API，只承载请求校验和 Agent DTO 映射。
 *
 * @returns 已注册路由的 Fastify 实例。
 */
export function createApiServer(): FastifyInstance {
  const app = Fastify({
    logger: true
  });
  const dataSourceRuntime = createDataSourceRuntime();

  /**
   * 健康检查接口只暴露 API 服务存活状态，供本地 dev server、脚本和部署探针快速验证。
   *
   * @returns 服务名称和 ok 状态。
   */
  app.get("/health", async () => ({
    ok: true,
    service: "@aiagent/api"
  }));

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

    const result = await dataSourceRuntime.ingest({
      source: parsed.data.source.trim(),
      fileName: parsed.data.fileName.trim(),
      contentType: parsed.data.contentType?.trim(),
      content: parsed.data.content
    });

    if (!result.ok) {
      reply.code(400);
      return fail(toApiErrorFromRagError(result.error, requestId), requestId);
    }

    return {
      ok: true,
      data: result.data,
      requestId
    };
  });

  /**
   * Data Sources 文档列表接口只读取当前进程内 runtime 快照，不在 API 层保存业务状态。
   *
   * @returns 当前已 ingest 的文档列表。
   */
  app.get("/api/data-sources/documents", async (): Promise<ApiResult<DataSourceDocumentsResponseDto>> => {
    const requestId = createRequestId();

    return {
      ok: true,
      data: {
        documents: dataSourceRuntime.listDocuments()
      },
      requestId
    };
  });

  /**
   * Data Sources chunk 列表接口返回可展示 chunk，不暴露 embedding 向量等内部索引字段。
   *
   * @returns 当前已索引的 chunk 列表。
   */
  app.get("/api/data-sources/chunks", async (): Promise<ApiResult<DataSourceChunksResponseDto>> => {
    const requestId = createRequestId();

    return {
      ok: true,
      data: {
        chunks: dataSourceRuntime.listChunks()
      },
      requestId
    };
  });

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
    });

    if (!result.ok) {
      reply.code(400);
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
    });

    if (!result.ok) {
      reply.code(400);
      return fail(toApiErrorFromRagError(result.error, requestId), requestId);
    }

    return {
      ok: true,
      data: result.data,
      requestId
    };
  });

  /**
   * Agent run 接口负责把前端研究问题转交给 agent package，API 层只做请求校验和 DTO 映射。
   *
   * @param request Fastify 请求对象，body 必须符合 AgentRunRequestDto。
   * @param reply Fastify 响应对象，用于在请求无效或服务异常时设置 HTTP 状态码。
   * @returns 成功时返回 Agent run 响应、steps 和 trace；失败时返回结构化 ApiResult。
   */
  app.post("/api/agent/run", async (request, reply): Promise<ApiResult<AgentRunResponseDto>> => {
    const requestId = createRequestId();
    const parsed = agentRunRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "请求格式不正确，请输入有效的研究问题。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const message = parsed.data.message.trim();

    if (!message) {
      const error = toApiError("validation_failed", "请输入需要研究或解释的问题。", requestId);
      reply.code(400);
      return fail(error, requestId);
    }

    try {
      const agentResponse = await runAgent({
        message
      });
      const responseDto = toAgentRunResponseDto(agentResponse, parsed.data, requestId);

      return {
        ok: true,
        data: responseDto,
        requestId
      };
    } catch (error) {
      const apiError = toApiError("internal_error", "Agent 服务暂时不可用，请稍后重试。", requestId, {
        cause: error instanceof Error ? error.message : "unknown"
      });
      reply.code(500);
      return fail(apiError, requestId);
    }
  });

  return app;
}

/**
 * 将 AgentResponse 投影为前端稳定 DTO，避免 UI 依赖内部实现细节。
 *
 * @param response Agent 运行结果。
 * @param requestDto API 请求 DTO。
 * @param requestId API 层请求标识。
 * @returns 前端消费的 Agent run 响应 DTO。
 */
function toAgentRunResponseDto(
  response: AgentResponse,
  requestDto: AgentRunRequestDto,
  requestId: string
): AgentRunResponseDto {
  return {
    conversationId: requestDto.conversationId ?? DEFAULT_CONVERSATION_ID,
    requestId: response.requestId || requestId,
    traceId: response.traceId,
    ok: response.ok,
    intent: response.intent,
    answer: response.answer,
    steps: response.steps.map(toAgentStepDto),
    trace: response.trace,
    error: response.error
      ? {
          code: "agent_failed",
          message: response.error.message,
          requestId,
          details: {
            agentCode: response.error.code,
            reportMode: requestDto.reportMode ?? false,
            ...response.error.details
          }
        }
      : undefined
  };
}

/**
 * 收窄 Agent step 字段，保持工具调用面板只消费稳定展示信息。
 *
 * @param step Agent 内部步骤。
 * @returns 前端步骤 DTO。
 */
function toAgentStepDto(step: AgentStep): AgentStepDto {
  return {
    index: step.index,
    type: step.type,
    status: step.status,
    durationMs: step.durationMs,
    data: step.data,
    error: step.error
      ? {
          code: "agent_failed",
          message: step.error.message,
          details: {
            agentCode: step.error.code,
            ...step.error.details
          }
        }
      : undefined
  };
}

/**
 * 构造 API 失败结构，避免把原始异常对象直接返回给浏览器。
 *
 * @param error 结构化 API 错误。
 * @param requestId API 请求标识。
 * @returns ApiResult 失败分支。
 */
function fail<TData>(error: ApiError, requestId: string): ApiResult<TData> {
  return {
    ok: false,
    error,
    requestId
  };
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
function toApiError(
  code: ApiError["code"],
  message: string,
  requestId: string,
  details?: Record<string, unknown>
): ApiError {
  return {
    code,
    message,
    requestId,
    details
  };
}

/**
 * 把 RAG runtime 的结构化错误映射成 API 边界错误。
 *
 * @param error RAG runtime 错误。
 * @param requestId API 请求标识。
 * @returns 前端可消费的 ApiError。
 */
function toApiErrorFromRagError(error: RagStructuredError, requestId: string): ApiError {
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
 * 生成 API adapter 自己的请求标识，和 Agent trace request id 分层展示。
 *
 * @returns 带 api_req_ 前缀的请求标识。
 */
function createRequestId(): string {
  return `api_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
