import {
  createIdentityService,
  createInMemoryIdentityRepository,
  type IdentityService,
  type IdentitySnapshot
} from "@aiagent/identity";
import type { LlmClient } from "@aiagent/types";
import { createDataSourceRuntime, isSafeRagSourceUri, type DataSourceRuntime } from "@aiagent/rag";
import { createLocalArtifactStorage, renderResearchReportPdf } from "@aiagent/report";
import type { ArtifactRepository, ArtifactStorage, WorkflowRepository } from "@aiagent/report";
import type { RagStructuredError } from "@aiagent/rag";
import { createInMemoryTraceStore, redactSensitiveValue } from "@aiagent/trace";
import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  AgentRunSnapshotDto,
  AgentRunStreamEventDto,
  ApiError,
  ApiResult,
  DataSourceChunksResponseDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto,
  IdentityBootstrapRequestDto,
  IdentityMeDto,
  QqBindingChallengeDto,
  QqBindingStatusDto,
  RagAnswerResponseDto,
  RagSearchResponseDto,
  ReportArtifactDto,
  ReportWorkflowResponseDto,
  ProductArchitectureDto,
  ProductEvalReportDto,
  ToolApprovalDecisionDto,
  TraceDto
} from "@aiagent/types";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createInMemoryExecutionRegistry,
  createInMemoryRunEventBus,
  createInMemoryRunStore,
  createMicrotaskRunScheduler
} from "./adapters/in-memory-run-runtime.js";
import { createRunApplicationService } from "./application/run-service.js";
import { createInMemoryReportRepositories } from "./adapters/in-memory-report-persistence.js";
import { publishArtifactPdf } from "./application/artifact-service.js";

const agentRunRequestSchema = z.object({
  message: z.string(),
  conversationId: z.string().min(1),
  mode: z.enum(["auto", "report"]),
  source: z.enum(["composer", "report_button"])
});
const identityBootstrapSchema = z.object({
  visitorId: z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/),
  fingerprintVersion: z.string().min(1).max(40)
});
const dataSourceIngestRequestSchema = z.object({
  // source 安全边界与 RAG runtime 写入口一致：拒绝本地路径、file: URI 和目录穿越。
  source: z.string().min(1).refine(isSafeRagSourceUri, {
    message: "source 仅支持 http(s) URL、mock:/demo: URI 或相对逻辑标识"
  }),
  fileName: z.string().min(1),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1)
});
const dataSourceDocumentsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
});
const dataSourceChunksQuerySchema = dataSourceDocumentsQuerySchema.extend({
  documentId: z.string().min(1).optional()
});
const ragSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().optional()
});
const ragAnswerRequestSchema = z.object({
  question: z.string().min(1),
  topK: z.number().int().positive().optional()
});
const approvalDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().max(240).optional(),
  inputDigest: z.string().min(1)
});
export interface ApiServerOptions {
  llmClient?: LlmClient;
  readiness?: () => Promise<{ ok: boolean; dependency: string; message?: string }>;
  identityService?: IdentityService;
  dataSourceRuntime?: DataSourceRuntime;
  requireIdentity?: boolean;
  qqBotQrUrl?: string;
  qqBotEnabled?: boolean;
  qqBotStatus?: () => IdentityMeDto["qqBot"]["status"];
  cookieSecure?: boolean;
  workflowRepository?: WorkflowRepository;
  artifactRepository?: ArtifactRepository;
  artifactStorage?: ArtifactStorage;
}

/**
 * 创建 Week 1 最小 HTTP API，只承载请求校验和 Agent DTO 映射。
 *
 * @returns 已注册路由的 Fastify 实例。
 */
export function createApiServer(options: ApiServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: true
  });
  const dataSourceRuntime = options.dataSourceRuntime ?? createDataSourceRuntime();
  const approvalDecisions = new Map<string, ToolApprovalDecisionDto>();
  const pendingApprovals = new Map<string, import("@aiagent/types").ToolApprovalRequestDto>();
  const approvalRunIds = new Map<string, string>();
  const inMemoryReport = createInMemoryReportRepositories();
  const workflowRepository = options.workflowRepository ?? inMemoryReport.workflowRepository;
  const artifactRepository = options.artifactRepository ?? inMemoryReport.artifactRepository;
  const artifactStorage = options.artifactStorage ?? createLocalArtifactStorage(
    process.env.ARTIFACT_STORAGE_ROOT ?? `${process.cwd()}/.artifacts-test`
  );
  const traceStore = createInMemoryTraceStore();
  const runStore = createInMemoryRunStore();
  const runEventBus = createInMemoryRunEventBus();
  const runService = createRunApplicationService({
    store: runStore,
    eventBus: runEventBus,
    executionRegistry: createInMemoryExecutionRegistry(),
    scheduler: createMicrotaskRunScheduler(),
    llmClient: options.llmClient,
    sink: {
      saveTrace: (trace) => { traceStore.save(trace); },
      saveWorkflow: async (workflow, context) => {
        await workflowRepository.save({ context, run: workflow.run });
      },
      saveArtifact: async (artifact, context) => {
        await artifactRepository.save({
          artifact, ...context, kind: "research_report", mediaType: "text/html",
          metadata: {}, updatedAt: artifact.createdAt
        });
      },
      saveApproval: (approval, runId) => {
        pendingApprovals.set(approval.approvalId, approval);
        approvalRunIds.set(approval.approvalId, runId);
      }
    }
  });
  const identityService = options.identityService ?? createIdentityService(
    createInMemoryIdentityRepository(),
    { fingerprintPepper: "test-only-identity-pepper" }
  );
  const identityByRequest = new WeakMap<object, IdentitySnapshot>();

  /**
   * 统一解析 session，使业务 route 只能读取服务端确认的 userId。
   * 生产 server 开启 requireIdentity；测试可注入身份服务并逐步验证旧 route。
   */
  app.addHook("preHandler", async (request, reply) => {
    const isPublic = request.url === "/health"
      || request.url === "/ready"
      || request.url === "/api/identity/bootstrap";
    if (isPublic) return;
    const identity = await identityService.authenticate(readCookie(request.headers.cookie, "aiagent_session"));
    if (identity) {
      identityByRequest.set(request, identity);
      return;
    }
    if (options.requireIdentity || request.url.startsWith("/api/identity/")) {
      const requestId = createRequestId();
      reply.code(401).send(fail(toApiError("unauthorized", "身份 session 无效，请重新识别浏览器。", requestId), requestId));
    }
  });

  /**
   * 健康检查接口只暴露 API 服务存活状态，供本地 dev server、脚本和部署探针快速验证。
   *
   * @returns 服务名称和 ok 状态。
   */
  app.get("/health", async () => ({
    ok: true,
    service: "@aiagent/api"
  }));

  /** readiness 会检查启动模式所需依赖；失败返回 503，避免流量进入不可服务实例。 */
  app.get("/ready", async (_request, reply) => {
    const state = options.readiness
      ? await options.readiness()
      : { ok: true, dependency: "mock-runtime" };
    if (!state.ok) reply.code(503);
    return { ...state, service: "@aiagent/api" };
  });

  /** 首次访问通过浏览器指纹创建/恢复 userId，并以 HttpOnly cookie 保存 session。 */
  app.post("/api/identity/bootstrap", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const parsed = identityBootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail(toApiError("validation_failed", "浏览器指纹格式不正确。", requestId, { issues: parsed.error.issues }), requestId);
    }
    const created = await identityService.bootstrap(
      (parsed.data satisfies IdentityBootstrapRequestDto).visitorId,
      parsed.data.fingerprintVersion
    );
    reply.header("set-cookie", serializeSessionCookie(created.token, created.expiresAt, options.cookieSecure ?? process.env.NODE_ENV === "production"));
    return { ok: true, requestId, data: toIdentityMeDto(created.snapshot, options) };
  });

  /** 返回当前 session 对应的稳定 userId 与 QQ 绑定状态。 */
  app.get("/api/identity/me", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    return { ok: true, requestId, data: toIdentityMeDto(identity, options) };
  });

  /** 为当前 userId 生成 QQ 私聊绑定码。 */
  app.post("/api/identity/qq-binding-challenges", async (request, reply): Promise<ApiResult<QqBindingChallengeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    if (!options.qqBotEnabled) {
      reply.code(503);
      return fail(toApiError("internal_error", "QQ Bot 尚未配置。", requestId, { reasonCode: "qq_bot_not_configured" }), requestId);
    }
    if (identity.qqIdentity) {
      reply.code(409);
      return fail(toApiError("conflict", "当前 userId 已绑定 QQ。", requestId), requestId);
    }
    const challenge = await identityService.createQqBindingChallenge(identity.userId);
    return {
      ok: true,
      requestId,
      data: {
        challengeId: challenge.challengeId,
        code: challenge.code,
        command: `/bind ${challenge.code}`,
        expiresAt: challenge.expiresAt,
        botQrUrl: options.qqBotQrUrl
      }
    };
  });

  /** 供 Settings 轮询 QQ 命令是否已经消费绑定码。 */
  app.get<{ Params: { challengeId: string } }>("/api/identity/qq-binding-challenges/:challengeId", async (request, reply): Promise<ApiResult<QqBindingStatusDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    const status = await identityService.getQqBindingStatus(request.params.challengeId, identity.userId);
    const qqIdentity = status === "bound" ? await identityService.repository.getQqIdentityByUserId(identity.userId) : undefined;
    return {
      ok: true,
      requestId,
      data: {
        challengeId: request.params.challengeId,
        status,
        qqIdentity: qqIdentity ? { botAccountId: qqIdentity.botAccountId, boundAt: qqIdentity.boundAt } : undefined
      }
    };
  });

  /** 从当前 Web 身份解除 QQ 绑定。 */
  app.delete("/api/identity/qq-identity", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    await identityService.unbindQq(identity.userId);
    const user = await identityService.repository.getUser(identity.userId);
    if (!user) {
      reply.code(404);
      return fail(toApiError("not_found", "用户不存在。", requestId), requestId);
    }
    return {
      ok: true,
      requestId,
      data: toIdentityMeDto({ userId: user.userId, createdAt: user.createdAt }, options)
    };
  });

  /** 按对外 requestId 返回完整脱敏 trace；当前仅保存在 API 进程内存。 */
  app.get<{ Params: { requestId: string } }>("/api/traces/:requestId", async (request, reply): Promise<ApiResult<TraceDto>> => {
    const lookupRequestId = createRequestId();
    const trace = traceStore.getByRequestId(request.params.requestId);
    if (!trace) {
      reply.code(404);
      return fail(toApiError("not_found", "Trace 不存在或已随进程重启清除。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, data: trace, requestId: lookupRequestId };
  });

  /** 创建异步研究 run；真实执行在响应返回后开始。 */
  app.post("/api/runs", async (request, reply): Promise<ApiResult<AgentRunAcceptedDto>> => {
    const requestId = createRequestId();
    const parsed = agentRunRequestSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.message.trim()) {
      reply.code(400);
      return fail(toApiError("validation_failed", "请输入有效的研究问题。", requestId, {
        issues: parsed.success ? undefined : parsed.error.issues
      }), requestId);
    }
    const identity = identityByRequest.get(request);
    const accepted = await runService.create(
      parsed.data satisfies AgentRunCreateRequestDto,
      identity?.userId ?? "00000000-0000-0000-0000-000000000000"
    );
    reply.code(202);
    return { ok: true, requestId: accepted.requestId, data: accepted };
  });

  /** 返回当前 run 快照，供刷新恢复和非流式诊断使用。 */
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply): Promise<ApiResult<AgentRunSnapshotDto>> => {
    const lookupRequestId = createRequestId();
    const run = await runService.get(request.params.runId);
    if (!run) {
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, requestId: lookupRequestId, data: run };
  });

  /** 显式取消 run；浏览器断开 SSE 不会隐式终止后台任务。 */
  app.delete<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply): Promise<ApiResult<AgentRunSnapshotDto>> => {
    const lookupRequestId = createRequestId();
    const run = await runService.cancel(request.params.runId);
    if (!run) {
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, requestId: lookupRequestId, data: run };
  });

  /** 以 SSE 重放历史事件并继续推送新增事件。 */
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", async (request, reply) => {
    const run = await runService.get(request.params.runId);
    if (!run) {
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", createRequestId()), createRequestId());
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const header = request.headers["last-event-id"];
    const lastEventId = Number(Array.isArray(header) ? header[0] : header ?? 0);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    const writeEvent = (event: AgentRunStreamEventDto): void => {
      reply.raw.write(`id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "run_result" || event.type === "run_error") {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    };
    for (const event of run.events) {
      if (event.sequence > lastEventId) writeEvent(event);
    }
    if (run.result || run.error) return;
    const unsubscribe = runService.subscribe(run.runId, writeEvent);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

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
   * Approval decision 接口只接收人工 approve/reject 决策并存入当前进程内存。
   * 权限判断仍由 packages/tools 或 packages/workflow 在执行敏感动作前完成。
   *
   * @param request Fastify 请求对象，body 必须符合 ToolApprovalDecisionDto。
   * @param reply Fastify 响应对象，用于在请求无效时设置 HTTP 状态码。
   * @returns 成功时返回已记录的 approval decision。
   */
  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/api/runs/:runId/approvals/:approvalId/decision",
    async (request, reply): Promise<ApiResult<ToolApprovalDecisionDto>> => {
    const requestId = createRequestId();
    const parsed = approvalDecisionRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "Approval decision 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const pending = pendingApprovals.get(request.params.approvalId);
    const run = await runService.get(request.params.runId);
    if (!run || !pending || approvalRunIds.get(request.params.approvalId) !== request.params.runId
      || (pending.inputDigest && parsed.data.inputDigest !== pending.inputDigest)) {
      reply.code(403);
      return fail(toApiError("forbidden", "Approval request 不存在、已处理或与原请求不匹配。", requestId, { reasonCode: "SEC_APPROVAL_BINDING_MISMATCH" }), requestId);
    }

    const decision: ToolApprovalDecisionDto = {
      approvalId: request.params.approvalId,
      decision: parsed.data.decision,
      reviewerNote: parsed.data.reviewerNote?.trim(),
      requestId: pending.requestId,
      inputDigest: parsed.data.inputDigest
    };
    approvalDecisions.set(decision.approvalId, decision);
    pendingApprovals.delete(decision.approvalId);
    approvalRunIds.delete(decision.approvalId);

    return {
      ok: true,
      data: decision,
      requestId
    };
  });

  /** 按服务端身份读取持久化 workflow 快照。 */
  app.get<{ Params: { runId: string } }>("/api/report-workflows/:runId", async (request, reply): Promise<ApiResult<ReportWorkflowResponseDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const value = await workflowRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.runId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report workflow run 不存在。", requestId), requestId);
    }
    const artifactId = `artifact_${value.run.runId}`;
    const artifact = await artifactRepository.findById(value.context.userId, artifactId);
    return { ok: true, data: { run: value.run, artifact: artifact?.artifact }, requestId };
  });

  /** 读取可预览报告 artifact，响应不暴露 report runtime 内部 state。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const value = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    return { ok: true, data: value.artifact, requestId };
  });

  /** 审批后生成真实 PDF；只按 artifact ID 访问持久化对象，不接受客户端文件路径。 */
  app.post<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/pdf", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const record = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    if (!record) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    const artifact = record.artifact;
    const approvalId = `approval_${artifact.workflowRunId}_pdf_exporter`;
    if (approvalDecisions.get(approvalId)?.decision !== "approved") {
      reply.code(403);
      return fail(toApiError("forbidden", "PDF 导出需要先批准对应 workflow 的 exporter。", requestId, { approvalId }), requestId);
    }
    const published = await publishArtifactPdf(
      record,
      artifactRepository,
      artifactStorage,
      () => renderResearchReportPdf({
        title: artifact.title,
        generatedAt: artifact.createdAt,
        markdown: artifact.markdown,
        citations: artifact.citations
      })
    );
    if (published.ok) return { ok: true, data: published.artifact, requestId };
    reply.code(500);
    return fail(toApiError(
      "internal_error",
      published.failureStatePersisted
        ? "PDF 生成失败，失败状态已记录，可安全重试。"
        : "PDF 生成失败且状态暂时无法保存，请稍后查询 Artifact 状态。",
      requestId,
      { failurePhase: published.phase, failureStatePersisted: published.failureStatePersisted }
    ), requestId);
  });

  /** 下载先校验用户归属，再用数据库中的不透明 storage key 读取 PDF。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/download", async (request, reply) => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const record = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    const artifact = record?.artifact;
    if (!record || !artifact || artifact.status !== "pdf_ready" || !record.storageKey) {
      reply.code(404);
      return fail(toApiError("not_found", "PDF 不存在或尚未完成。", requestId), requestId);
    }
    try {
      const bytes = await artifactStorage.readPdf(record.storageKey);
      reply.header("content-type", "application/pdf");
      reply.header("content-disposition", `attachment; filename="${sanitizeDownloadFileName(artifact.pdfExport.fileName ?? `${artifact.artifactId}.pdf`)}"`);
      return reply.send(Buffer.from(bytes));
    } catch {
      reply.code(500);
      return fail(toApiError("internal_error", "PDF 文件暂时无法读取，请稍后重试。", requestId), requestId);
    }
  });

  /** 软删除 Artifact metadata；物理 PDF 由后续维护任务清理。 */
  app.delete<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId", async (request, reply) => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const deleted = await artifactRepository.softDelete(
      identity?.userId ?? "00000000-0000-0000-0000-000000000000",
      request.params.artifactId,
      new Date().toISOString()
    );
    if (!deleted) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    reply.code(204);
    return reply.send();
  });

  /** Eval 产品页使用版本化 baseline 的确定性证据投影，并明确标注 demo dataset。 */
  app.get("/api/product/eval-report", async (): Promise<ApiResult<ProductEvalReportDto>> => {
    const requestId = createRequestId();
    const data: ProductEvalReportDto = {
      datasetVersion: "financial-research-v1.0.0", caseCount: 31, generatedAt: "2026-07-19T00:00:00.000Z",
      metrics: { citationCoverage: 0.935, financialAccuracy: 0.968, sourceGroundedness: 0.968, successRate: 0.903, averageLatencyMs: 22.839, p95LatencyMs: 45 },
      baseline: { citationCoverage: 0.935, financialAccuracy: 0.968, sourceGroundedness: 0.968, successRate: 0.903, averageLatencyMs: 22.839, p95LatencyMs: 45 },
      failures: [
        { caseId: "fail-001", query: "财务事实约束失败", rootCause: "数值、单位、币种、期间或来源未同时满足。", improvement: "增加结构化事实与期间校验。", traceId: "trace-fail-001", requestId: "request-fail-001" },
        { caseId: "fail-002", query: "引用 grounded 检查失败", rootCause: "引用文本无法在 retrieved chunk 中回溯。", improvement: "强化 citation verifier。", traceId: "trace-fail-002", requestId: "request-fail-002" },
        { caseId: "fail-003", query: "Report workflow 提前终止", rootCause: "workflow 在预期节点前终止。", improvement: "补齐节点重试与终止原因。", traceId: "trace-fail-003", requestId: "request-fail-003" }
      ], demoData: true
    };
    return { ok: true, data, requestId };
  });

  /** 架构产品页的关系来自当前 workspace package 边界。 */
  app.get("/api/product/architecture", async (): Promise<ApiResult<ProductArchitectureDto>> => {
    const requestId = createRequestId();
    return { ok: true, requestId, data: createProductArchitectureDto() };
  });

  return app;
}

/** @param fileName artifact 中的展示文件名。 @returns 不含控制字符和路径分隔符的下载名。 */
function sanitizeDownloadFileName(fileName: string): string {
  return fileName.replace(/[\\/\r\n"\x00-\x1F]/g, "_").slice(0, 120) || "immersive-report.pdf";
}

/** @returns 与仓库真实依赖方向一致的架构展示 DTO。 */
function createProductArchitectureDto(): ProductArchitectureDto {
  const nodes = [
    { id: "web", label: "apps/web", responsibility: "React 产品视图，只消费 HTTP DTO" },
    { id: "api", label: "apps/api", responsibility: "校验、生命周期、artifact store 与结构化错误" },
    { id: "agent", label: "packages/agent", responsibility: "intent routing、agent loop 与 report planner" },
    { id: "report", label: "packages/report", responsibility: "研报节点、writer 与 PDF renderer" },
    { id: "workflow", label: "packages/workflow", responsibility: "有限状态机、重试与审批" },
    { id: "rag", label: "packages/rag", responsibility: "ingestion、chunk、retrieval 与 citation" },
    { id: "tools", label: "packages/tools + mcp", responsibility: "工具 schema、权限和执行通道" },
    { id: "trace", label: "packages/trace", responsibility: "跨边界事件与运行指标" },
    { id: "types", label: "packages/types", responsibility: "小型稳定共享 DTO" }
  ];
  const edges = [
    { from: "web", to: "api", label: "HTTP DTO" }, { from: "api", to: "agent", label: "run" },
    { from: "api", to: "report", label: "workflow/export" }, { from: "agent", to: "tools", label: "tool calls" },
    { from: "report", to: "workflow", label: "runtime" }, { from: "report", to: "rag", label: "evidence" },
    { from: "agent", to: "trace", label: "events" }, { from: "report", to: "trace", label: "events" },
    { from: "web", to: "types", label: "contracts" }, { from: "api", to: "types", label: "contracts" }
  ];
  return { nodes, edges, demoData: false };
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

/**
 * 把领域身份映射成不暴露 QQ OpenID 的公共 DTO。
 *
 * @param identity 服务端确认的身份。
 * @param options QQ 渠道展示配置。
 * @returns Web 可消费的身份 DTO。
 */
function toIdentityMeDto(identity: IdentitySnapshot, options: ApiServerOptions): IdentityMeDto {
  return {
    userId: identity.userId,
    createdAt: identity.createdAt,
    qqIdentity: identity.qqIdentity
      ? { botAccountId: identity.qqIdentity.botAccountId, boundAt: identity.qqIdentity.boundAt }
      : undefined,
    qqBot: {
      enabled: options.qqBotEnabled ?? false,
      status: options.qqBotStatus?.() ?? (options.qqBotEnabled ? "stopped" : "disabled")
    }
  };
}

/**
 * 从 Cookie header 读取指定 cookie，避免将 cookie parser 依赖扩散到 API contract。
 *
 * @param header 原始 Cookie header。
 * @param name cookie 名称。
 * @returns 解码后的值。
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/**
 * 创建安全 session cookie；本地 HTTP 允许非 Secure，生产环境强制 HTTPS。
 *
 * @param token 不透明 session token。
 * @param expiresAt 过期时间。
 * @returns Set-Cookie header。
 */
function serializeSessionCookie(token: string, expiresAt: string, useSecure: boolean): string {
  const secure = useSecure ? "; Secure" : "";
  return `aiagent_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}
