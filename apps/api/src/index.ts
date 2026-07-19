import { runAgent } from "@aiagent/agent";
import type { AgentResponse, AgentStep } from "@aiagent/agent";
import type { LlmClient } from "@aiagent/types";
import { createDataSourceRuntime } from "@aiagent/rag";
import { renderResearchReportPdf, runReportWorkflow } from "@aiagent/report";
import type { ReportWorkflowResult } from "@aiagent/report";
import type { RagStructuredError } from "@aiagent/rag";
import { createInMemoryTraceRecorder, createInMemoryTraceStore, redactSensitiveValue } from "@aiagent/trace";
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
  RagSearchResponseDto,
  ReportArtifactDto,
  ReportPlanDto,
  ReportWorkflowResponseDto,
  ProductArchitectureDto,
  ProductEvalReportDto,
  ToolApprovalDecisionDto
  , TraceDto
} from "@aiagent/types";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const agentRunRequestSchema = z.object({
  message: z.string(),
  reportMode: z.boolean().optional(),
  reportTriggerSource: z.enum(["toggle", "button", "natural_language"]).optional(),
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
const approvalDecisionRequestSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().max(240).optional(),
  requestId: z.string().min(1).optional(),
  inputDigest: z.string().min(1).optional()
});
const startReportWorkflowRequestSchema = z.object({
  plan: z.custom<ReportPlanDto>((value) => typeof value === "object" && value !== null),
  requestId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional()
});

const DEFAULT_CONVERSATION_ID = "week1-local-session";

export interface ApiServerOptions {
  llmClient?: LlmClient;
  readiness?: () => Promise<{ ok: boolean; dependency: string; message?: string }>;
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
  const dataSourceRuntime = createDataSourceRuntime();
  const approvalDecisions = new Map<string, ToolApprovalDecisionDto>();
  const pendingApprovals = new Map<string, import("@aiagent/types").ToolApprovalRequestDto>();
  const workflowRuns = new Map<string, ReportWorkflowResponseDto>();
  const reportArtifacts = new Map<string, ReportArtifactDto>();
  const reportPdfFiles = new Map<string, Uint8Array>();
  const traceStore = createInMemoryTraceStore();

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
   * Approval decision 接口只接收人工 approve/reject 决策并存入当前进程内存。
   * 权限判断仍由 packages/tools 或 packages/workflow 在执行敏感动作前完成。
   *
   * @param request Fastify 请求对象，body 必须符合 ToolApprovalDecisionDto。
   * @param reply Fastify 响应对象，用于在请求无效时设置 HTTP 状态码。
   * @returns 成功时返回已记录的 approval decision。
   */
  app.post("/api/approvals/decision", async (request, reply): Promise<ApiResult<ToolApprovalDecisionDto>> => {
    const requestId = createRequestId();
    const parsed = approvalDecisionRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "Approval decision 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const pending = pendingApprovals.get(parsed.data.approvalId.trim());
    if (!pending || (pending.requestId && parsed.data.requestId !== pending.requestId) || (pending.inputDigest && parsed.data.inputDigest !== pending.inputDigest)) {
      reply.code(403);
      return fail(toApiError("forbidden", "Approval request 不存在、已处理或与原请求不匹配。", requestId, { reasonCode: "SEC_APPROVAL_BINDING_MISMATCH" }), requestId);
    }

    const decision: ToolApprovalDecisionDto = {
      approvalId: parsed.data.approvalId.trim(),
      decision: parsed.data.decision,
      reviewerNote: parsed.data.reviewerNote?.trim(),
      requestId: parsed.data.requestId,
      inputDigest: parsed.data.inputDigest
    };
    approvalDecisions.set(decision.approvalId, decision);
    pendingApprovals.delete(decision.approvalId);

    return {
      ok: true,
      data: decision,
      requestId
    };
  });

  /** 启动报告 workflow；API 仅负责生命周期与 DTO 投影，节点逻辑留在 report package。 */
  app.post("/api/report-workflows", async (request, reply): Promise<ApiResult<ReportWorkflowResponseDto>> => {
    const requestId = createRequestId();
    const parsed = startReportWorkflowRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail(toApiError("validation_failed", "Report workflow 请求格式不正确。", requestId), requestId);
    }

    const priorTrace = parsed.data.requestId ? traceStore.getByRequestId(parsed.data.requestId) : undefined;
    const trace = createInMemoryTraceRecorder(
      parsed.data.traceId ?? priorTrace?.traceId,
      parsed.data.requestId ?? requestId,
      priorTrace?.events,
      priorTrace?.startedAt
    );
    const result = await runReportWorkflow(parsed.data.plan, { documents: createReportDemoDocuments(), trace });
    traceStore.save(trace.getTrace());
    const response = redactSensitiveValue(toReportWorkflowResponseDto(result));
    if (response.run.approvalRequest) pendingApprovals.set(response.run.approvalRequest.approvalId, response.run.approvalRequest);
    workflowRuns.set(response.run.runId, response);
    if (response.artifact) reportArtifacts.set(response.artifact.artifactId, response.artifact);
    return { ok: true, data: response, requestId: trace.requestId };
  });

  /** 读取进程内 workflow 快照；本阶段明确不提供持久化 artifact store。 */
  app.get<{ Params: { runId: string } }>("/api/report-workflows/:runId", async (request, reply): Promise<ApiResult<ReportWorkflowResponseDto>> => {
    const requestId = createRequestId();
    const value = workflowRuns.get(request.params.runId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report workflow run 不存在。", requestId), requestId);
    }
    return { ok: true, data: value, requestId };
  });

  /** 读取可预览报告 artifact，响应不暴露 report runtime 内部 state。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const value = reportArtifacts.get(request.params.artifactId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    return { ok: true, data: value, requestId };
  });

  /** 审批后生成真实 PDF；只按 artifact ID 访问内存对象，不接受客户端文件路径。 */
  app.post<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/pdf", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const artifact = reportArtifacts.get(request.params.artifactId);
    if (!artifact) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    const approvalId = `approval_${artifact.workflowRunId}_pdf_exporter`;
    if (approvalDecisions.get(approvalId)?.decision !== "approved") {
      reply.code(403);
      return fail(toApiError("forbidden", "PDF 导出需要先批准对应 workflow 的 exporter。", requestId, { approvalId }), requestId);
    }
    try {
      const bytes = renderResearchReportPdf({ title: artifact.title, generatedAt: artifact.createdAt, markdown: artifact.markdown, citations: artifact.citations });
      reportPdfFiles.set(artifact.artifactId, bytes);
      const updated: ReportArtifactDto = {
        ...artifact,
        status: "pdf_ready",
        pdfExport: {
          status: "ready",
          fileName: artifact.pdfExport.fileName ?? `${artifact.artifactId}.pdf`,
          message: "真实 PDF 已生成并通过 artifact ID 提供下载。",
          generatedAt: new Date().toISOString(),
          downloadUrl: `/api/report-artifacts/${encodeURIComponent(artifact.artifactId)}/download`
        }
      };
      reportArtifacts.set(updated.artifactId, updated);
      return { ok: true, data: updated, requestId };
    } catch {
      const error = toApiError("internal_error", "PDF 生成失败，可安全重试。", requestId);
      const updated: ReportArtifactDto = { ...artifact, status: "pdf_failed", pdfExport: { status: "failed", fileName: artifact.pdfExport.fileName, message: error.message, error } };
      reportArtifacts.set(updated.artifactId, updated);
      reply.code(500);
      return fail(error, requestId);
    }
  });

  /** 下载只查找已生成的内存 artifact，永不拼接或读取用户提供的路径。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/download", async (request, reply) => {
    const artifact = reportArtifacts.get(request.params.artifactId);
    const bytes = reportPdfFiles.get(request.params.artifactId);
    if (!artifact || artifact.status !== "pdf_ready" || !bytes) {
      reply.code(404);
      return fail(toApiError("not_found", "PDF 不存在、尚未完成或已随进程重启清除。", createRequestId()), createRequestId());
    }
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename="${sanitizeDownloadFileName(artifact.pdfExport.fileName ?? `${artifact.artifactId}.pdf`)}"`);
    return reply.send(Buffer.from(bytes));
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
      const trace = createInMemoryTraceRecorder(undefined, requestId);
      const agentResponse = await runAgent({
        message,
        reportMode: parsed.data.reportMode,
        reportTriggerSource: parsed.data.reportTriggerSource
      }, { traceRecorder: trace, llmClient: options.llmClient });
      traceStore.save(agentResponse.trace);
      const responseDto = redactSensitiveValue(toAgentRunResponseDto(agentResponse, parsed.data, requestId));
      registerTraceApprovals(responseDto.trace, pendingApprovals);

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
 * 从服务端生成的 trace 登记待审批请求，API 不接受模型自行构造的 approval id。
 *
 * @param trace 已脱敏 trace DTO。
 * @param pendingApprovals 当前进程待审批表。
 * @returns 无返回值。
 */
function registerTraceApprovals(trace: TraceDto, pendingApprovals: Map<string, import("@aiagent/types").ToolApprovalRequestDto>): void {
  for (const event of trace.events) {
    if (event.type !== "approval" || event.status !== "requested") continue;
    pendingApprovals.set(event.approvalId, { approvalId: event.approvalId, traceId: event.traceId, requestId: event.requestId, toolName: event.toolName, reason: event.reason, reasonCode: event.reasonCode, inputPreview: event.inputPreview, inputDigest: event.inputDigest, permissionLevel: "needs_approval" });
  }
}

/** 将 report package 结果收窄为 Web 稳定 DTO；PDF 在审批后的独立 artifact 边界生成。 */
function toReportWorkflowResponseDto(result: ReportWorkflowResult): ReportWorkflowResponseDto {
  const draft = result.state.draft;
  const citations = result.state.citations;
  const artifact: ReportArtifactDto | undefined = draft && citations ? {
    artifactId: `artifact_${result.run.runId}`,
    reportId: result.state.plan.planId,
    workflowRunId: result.run.runId,
    status: "html_preview_only",
    title: draft.title,
    markdown: draft.markdown,
    html: draft.html,
    citations: citations.citations,
    citationVerification: {
      decision: citations.decision,
      verified: citations.verified,
      missingClaims: citations.missingClaims,
      missingMetrics: citations.missingMetrics
    },
    pdfExport: {
      status: "queued",
      fileName: result.state.export?.fileName,
      message: result.state.export?.message ?? "PDF Exporter 等待人工批准；批准后可安全重试生成。"
    },
    createdAt: new Date().toISOString()
  } : undefined;
  return { run: result.run, artifact };
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

/** Demo 文档只位于 API adapter，用于 Week 3 可重复演示；真实数据入口仍是 RAG ingestion。 */
function createReportDemoDocuments() {
  return [{
    source: "demo://000001-sz-annual-report",
    fileName: "000001-SZ-annual-report.md",
    contentType: "text/markdown",
    content: "# 盈利能力\n000001.SZ 最近两年营业收入保持增长，净利润同比改善，ROE 为 12.4%。\n\n# 资产质量与风险\n不良贷款率保持稳定，拨备覆盖率处于安全水平；宏观利率变化和信用成本仍是主要风险。\n\n# 现金流\n经营性现金流改善，但市场波动可能影响短期表现。"
  }];
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
    reportPlan: response.reportPlan,
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
