import { runAgent } from "@aiagent/agent";
import type { AgentResponse, AgentStep } from "@aiagent/agent";
import { runReportWorkflow } from "@aiagent/report";
import type { LlmClient } from "@aiagent/types";
import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  AgentRunEventInputDto,
  AgentRunResponseDto,
  AgentRunSnapshotDto,
  AgentRunStatusDto,
  AgentRunStreamEventDto,
  AgentStepDto,
  ApiError,
  ReportArtifactDto,
  ReportWorkflowResponseDto,
  ToolApprovalRequestDto,
  TraceDto
} from "@aiagent/types";
import { createObservableTraceRecorder, redactSensitiveValue } from "@aiagent/trace";
import { createHash, randomUUID } from "node:crypto";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "./run-ports.js";

type RunEventPayload =
  | { type: "run_status"; status: AgentRunStatusDto; message: string }
  | { type: "trace_event"; event: TraceDto["events"][number] }
  | { type: "run_result"; result: AgentRunResponseDto }
  | { type: "run_error"; error: ApiError };

export interface RunServiceSink {
  saveTrace(trace: TraceDto): void;
  saveWorkflow(workflow: ReportWorkflowResponseDto, context: ReportPersistenceContext): Promise<void>;
  saveArtifact(artifact: ReportArtifactDto, context: ReportPersistenceContext): Promise<void>;
  saveApproval(approval: ToolApprovalRequestDto, runId: string): void;
}

export interface RunServiceDependencies {
  store: RunStore;
  eventBus: RunEventBus;
  executionRegistry: RunExecutionRegistry;
  scheduler: RunScheduler;
  sink: RunServiceSink;
  llmClient?: LlmClient;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

export interface RunApplicationService {
  create(request: AgentRunCreateRequestDto, userId: string): Promise<AgentRunAcceptedDto>;
  get(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  cancel(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  listEvents(userId: string, runId: string, afterSequence: number): Promise<AgentRunStreamEventDto[] | undefined>;
  subscribe(runId: string, listener: (event: AgentRunStreamEventDto) => void): () => void;
  recoverStale(before: string): Promise<number>;
}

export interface ReportPersistenceContext {
  userId: string;
  conversationId: string;
  agentRunId: string;
  planId: string;
}

/**
 * 创建 Run application service，集中管理状态机、canonical event 与执行生命周期。
 *
 * @param dependencies 可替换端口和 runtime adapter。
 * @returns Run 用例接口。
 */
export function createRunApplicationService(dependencies: RunServiceDependencies): RunApplicationService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? defaultCreateId;
  async function publish(userId: string, runId: string, payload: RunEventPayload): Promise<AgentRunStreamEventDto | undefined> {
    const current = await dependencies.store.findById(userId, runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const eventInput = redactSensitiveValue({
      ...payload,
      runId,
      requestId: current.requestId,
      traceId: `trace_${runId}`,
      conversationId: current.conversationId,
      createdAt: now().toISOString()
    }) as AgentRunEventInputDto;
    const event = await dependencies.store.append(userId, runId, eventInput);
    // live fan-out 只能发生在 adapter 的数据库事务提交之后。
    if (event) dependencies.eventBus.publish(event);
    return event;
  }

  async function execute(runId: string, request: AgentRunCreateRequestDto, userId: string): Promise<void> {
    const controller = dependencies.executionRegistry.get(runId);
    if (!controller) return;
    await publish(userId, runId, { type: "run_status", status: "running", message: "Agent 已开始分析研究任务。" });
    const snapshot = await dependencies.store.findById(userId, runId);
    if (!snapshot) return;
    const trace = createObservableTraceRecorder(`trace_${runId}`, snapshot.requestId);
    const unsubscribe = trace.subscribe((event) => { void publish(userId, runId, { type: "trace_event", event }); });
    try {
      const response = await runAgent({
        message: request.message.trim(),
        reportMode: request.mode === "report",
        reportTriggerSource: request.mode === "report"
          ? request.source === "report_button" ? "button" : "toggle"
          : undefined,
        signal: controller.signal
      }, { traceRecorder: trace, llmClient: dependencies.llmClient });
      const workflow = await maybeRunReport(runId, userId, request.conversationId, response, trace, controller.signal, dependencies.sink);
      response.trace = trace.getTrace();
      dependencies.sink.saveTrace(response.trace);
      const result = redactSensitiveValue(toResponseDto(runId, response, request, snapshot.requestId, workflow));
      registerApprovals(runId, result.trace, dependencies.sink);
      await publish(userId, runId, { type: "run_result", result });
    } catch (caught) {
      await publish(userId, runId, {
        type: "run_error",
        error: toRunError(caught, snapshot.requestId, controller.signal.aborted)
      });
    } finally {
      unsubscribe();
      dependencies.executionRegistry.delete(runId);
    }
  }

  return {
    async create(request, userId) {
      const runId = createId("run");
      // 浏览器幂等键按用户命名空间化，既满足全局唯一约束，也不会产生跨用户冲突侧信道。
      const requestId = request.clientMessageId
        ? `req_${createHash("sha256").update(`${userId}\0${request.clientMessageId}`).digest("hex")}`
        : createId("api_req");
      const createdAt = now().toISOString();
      const created = await dependencies.store.create({
        runId, requestId, userId, conversationId: request.conversationId,
        message: request.message.trim(), clientMessageId: request.clientMessageId ?? requestId,
        mode: request.mode, source: request.source, traceId: `trace_${runId}`, createdAt
      });
      const actual = created.snapshot;
      if (!created.created) return {
        runId: actual.runId, requestId: actual.requestId, conversationId: actual.conversationId,
        status: actual.status, eventsUrl: `/api/runs/${actual.runId}/events`, snapshotUrl: `/api/runs/${actual.runId}`
      };
      dependencies.executionRegistry.create(runId);
      await publish(userId, runId, { type: "run_status", status: "queued", message: "研究任务已进入队列。" });
      dependencies.scheduler.schedule(() => execute(runId, request, userId));
      return {
        runId,
        requestId,
        conversationId: request.conversationId,
        status: "queued",
        eventsUrl: `/api/runs/${runId}/events`,
        snapshotUrl: `/api/runs/${runId}`
      };
    },
    get: (userId, runId) => dependencies.store.findById(userId, runId),
    async cancel(userId, runId) {
      const snapshot = await dependencies.store.findById(userId, runId);
      if (!snapshot) return undefined;
      if (["queued", "running", "waiting_approval"].includes(snapshot.status)) {
        dependencies.executionRegistry.get(runId)?.abort();
        await publish(userId, runId, { type: "run_status", status: "cancelled", message: "用户已请求取消研究任务。" });
      }
      return dependencies.store.findById(userId, runId);
    },
    listEvents: (userId, runId, afterSequence) => dependencies.store.listEvents(userId, runId, afterSequence),
    subscribe: (runId, listener) => dependencies.eventBus.subscribe(runId, listener),
    async recoverStale(before) {
      const events = await dependencies.store.recoverStale(before, now().toISOString());
      for (const event of events) dependencies.eventBus.publish(event);
      return events.length;
    }
  };
}

async function maybeRunReport(
  runId: string,
  userId: string,
  conversationId: string,
  response: AgentResponse,
  trace: ReturnType<typeof createObservableTraceRecorder>,
  signal: AbortSignal,
  sink: RunServiceSink
): Promise<ReportWorkflowResponseDto | undefined> {
  if (response.reportPlan?.status !== "ready" || signal.aborted) return undefined;
  const result = await runReportWorkflow(response.reportPlan, {
    documents: createReportDemoDocuments(),
    trace,
    signal
  });
  const workflow = redactSensitiveValue(toWorkflowDto(result));
  const context = { userId, conversationId, agentRunId: runId, planId: response.reportPlan.planId };
  await sink.saveWorkflow(workflow, context);
  if (workflow.run.approvalRequest) sink.saveApproval(workflow.run.approvalRequest, runId);
  if (workflow.artifact) await sink.saveArtifact(workflow.artifact, context);
  return workflow;
}

function toResponseDto(
  runId: string,
  response: AgentResponse,
  request: AgentRunCreateRequestDto,
  requestId: string,
  reportWorkflow?: ReportWorkflowResponseDto
): AgentRunResponseDto {
  return {
    runId,
    conversationId: request.conversationId,
    requestId: response.requestId || requestId,
    traceId: response.traceId,
    ok: response.ok,
    intent: response.intent,
    answer: response.answer,
    steps: response.steps.map(toStepDto),
    trace: response.trace,
    reportPlan: response.reportPlan,
    reportWorkflow,
    error: response.error ? {
      code: "agent_failed",
      message: response.error.message,
      requestId,
      details: { agentCode: response.error.code, mode: request.mode, ...response.error.details }
    } : undefined
  };
}

function toStepDto(step: AgentStep): AgentStepDto {
  return {
    index: step.index,
    type: step.type,
    status: step.status,
    durationMs: step.durationMs,
    data: step.data,
    error: step.error ? {
      code: "agent_failed",
      message: step.error.message,
      details: { agentCode: step.error.code, ...step.error.details }
    } : undefined
  };
}

function toWorkflowDto(result: Awaited<ReturnType<typeof runReportWorkflow>>): ReportWorkflowResponseDto {
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
      message: result.state.export?.message ?? "PDF Exporter 等待人工批准。"
    },
    createdAt: new Date().toISOString()
  } : undefined;
  return { run: result.run, artifact };
}

function toRunError(caught: unknown, requestId: string, cancelled: boolean): ApiError {
  void caught;
  return {
    code: cancelled ? "request_cancelled" : "internal_error",
    message: cancelled ? "Agent run 已取消。" : "Agent 服务暂时不可用，请稍后重试。",
    requestId
  };
}

function registerApprovals(runId: string, trace: TraceDto, sink: RunServiceSink): void {
  for (const event of trace.events) {
    if (event.type !== "approval" || event.status !== "requested") continue;
    sink.saveApproval({
      approvalId: event.approvalId,
      traceId: event.traceId,
      requestId: event.requestId,
      toolName: event.toolName,
      reason: event.reason,
      reasonCode: event.reasonCode,
      inputPreview: event.inputPreview,
      inputDigest: event.inputDigest,
      permissionLevel: "needs_approval"
    }, runId);
  }
}

function createReportDemoDocuments() {
  return [{
    source: "demo://000001-sz-annual-report",
    fileName: "000001-SZ-annual-report.md",
    contentType: "text/markdown",
    content: "# 盈利能力\n000001.SZ 最近两年营业收入保持增长，净利润同比改善，ROE 为 12.4%。\n\n# 资产质量与风险\n不良贷款率保持稳定，拨备覆盖率处于安全水平。"
  }];
}

function defaultCreateId(prefix: string): string {
  void prefix;
  return randomUUID();
}
