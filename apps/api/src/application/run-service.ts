import type { AgentMessage, AgentTool } from "@aiagent/agent";
import { runReportWorkflow } from "@aiagent/report";
import type { DataSourceRuntime } from "@aiagent/rag";
import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  AgentRunEventInputDto,
  AgentRunResponseDto,
  AgentRunSnapshotDto,
  AgentRunStatusDto,
  AgentRunStreamEventDto,
  ApiError,
  CitationDto,
  ReportArtifactDto,
  ReportPlanDto,
  ReportWorkflowResponseDto,
  ToolApprovalRequestDto,
  TraceDto
} from "@aiagent/types";
import {
  createObservableTraceRecorder,
  redactSensitiveValue,
  type TracePersistenceContext,
  type TraceStore
} from "@aiagent/trace";
import { createHash, randomUUID } from "node:crypto";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "./run-ports.js";
import { createPacedTraceRecorder } from "../adapters/paced-trace-recorder.js";
import { executeAgentLoop, type AgentExecutionResult } from "./agent-execution.js";
import type { ModelRuntime } from "./model-registry.js";

type RunEventPayload =
  | { type: "run_status"; status: AgentRunStatusDto; message: string }
  | { type: "trace_event"; event: TraceDto["events"][number] }
  | { type: "run_result"; result: AgentRunResponseDto }
  | { type: "run_error"; error: ApiError };

export interface RunServiceSink {
  saveWorkflow(workflow: ReportWorkflowResponseDto, context: ReportPersistenceContext): Promise<void>;
  saveArtifact(artifact: ReportArtifactDto, context: ReportPersistenceContext): Promise<void>;
  saveApproval(approval: ToolApprovalRequestDto, context: ApprovalPersistenceContext): Promise<void>;
}

export interface RunServiceDependencies {
  store: RunStore;
  eventBus: RunEventBus;
  executionRegistry: RunExecutionRegistry;
  scheduler: RunScheduler;
  sink: RunServiceSink;
  traceStore: TraceStore;
  /** 按目录模型 ID 解析可执行模型 runtime（MockModel 与真实 provider 同路径）。 */
  resolveModel: (modelId: string) => ModelRuntime | undefined;
  hasModel?: (modelId: string) => boolean;
  defaultModelId?: string;
  /** 注入 loop 的工具集（来自 ToolRegistry.list()）；工具选择由模型 function calling 完成。 */
  tools: AgentTool[];
  /** 单 run 最大 turn 数预算。 */
  maxTurns?: number;
  dataSourceRuntime?: DataSourceRuntime;
  /** 仅 mock composition 注入；按首次语义类别节流 live Trace，测试默认 0。 */
  mockStepDelayMs?: number;
  now?: () => Date;
  createId?: (prefix: string) => string;
  recordInternalWarning?: (warning: { code: "trace_persistence_degraded"; runId: string; requestId: string }) => void;
}

export interface RunApplicationService {
  create(request: AgentRunCreateRequestDto, userId: string): Promise<AgentRunAcceptedDto>;
  get(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  cancel(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  listEvents(userId: string, runId: string, afterSequence: number): Promise<AgentRunStreamEventDto[] | undefined>;
  subscribe(runId: string, listener: (event: AgentRunStreamEventDto) => void): () => void;
  recoverStale(before: string): Promise<number>;
  /** @returns 是否已进入 shutdown，新 Run 必须被拒绝。 */
  isShuttingDown(): boolean;
  /**
   * 优雅关闭：停止接收新 Run，中断在途执行并有限 drain，最后把仍未终态的 Run 标记为 interrupted。
   *
   * @param options.drainMs 等待在途 Run 收尾的最长时间。
   * @returns 被标记为 interrupted 的 Run 数量。
   */
  shutdown(options: { drainMs: number }): Promise<{ interrupted: number }>;
}

export interface ReportPersistenceContext {
  userId: string;
  conversationId: string;
  agentRunId: string;
  planId: string;
}

/** Approval 持久化归属上下文；userId 必须来自 Run 创建时的服务端身份。 */
export interface ApprovalPersistenceContext {
  runId: string;
  userId: string;
}

/** 会话历史在内存中按 conversation 累积的上限，超出后裁剪最旧消息（持久化裁剪属后续阶段）。 */
const MAX_HISTORY_MESSAGES = 200;

/**
 * 裁剪会话历史到上限；切点不落在 toolResult 上（复用 compaction 的切点思路），
 * 保证 AssistantMessage.toolCalls 与其 ToolResultMessage 同进同出不被截断。
 *
 * @param history 会话历史数组（就地裁剪）。
 */
function trimConversationHistory(history: AgentMessage[]): void {
  if (history.length <= MAX_HISTORY_MESSAGES) return;
  let cut = history.length - MAX_HISTORY_MESSAGES;
  while (cut < history.length && history[cut].role === "toolResult") {
    cut += 1;
  }
  history.splice(0, cut);
}

/**
 * 创建 Run application service，集中管理状态机、canonical event 与执行生命周期。
 * run 执行走 packages/agent 的 agentLoop（pi 形态多轮 ReAct），见 agent-execution.ts。
 *
 * @param dependencies 可替换端口和 runtime adapter。
 * @returns Run 用例接口。
 */
export function createRunApplicationService(dependencies: RunServiceDependencies): RunApplicationService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? defaultCreateId;
  // shutdown 期间拒绝新 Run，避免关闭窗口内写入无法 drain 的任务。
  let shuttingDown = false;
  // 会话历史内存累积：key 为 userId + conversationId；不建新表，进程重启即丢失（阶段内可接受）。
  const conversationHistories = new Map<string, AgentMessage[]>();
  // 同一 conversation 的 run 串行化链：并发创建的同会话 run 按 promise 链排队执行，
  // 避免历史交错与工具结果乱序（跨 conversation 不互相阻塞）。
  const conversationRunChains = new Map<string, Promise<void>>();
  async function recoverStale(before: string): Promise<number> {
    const events = await dependencies.store.recoverStale(before, now().toISOString());
    for (const event of events) dependencies.eventBus.publish(event);
    return events.length;
  }
  /**
   * 把同一会话的 run 挂到该会话的执行链尾部，实现 per-conversation 串行。
   * 链上失败不阻断后续排队任务（每个任务自行收尾）。
   *
   * @param key 会话键（userId:conversationId）。
   * @param task run 执行体。
   * @returns 本次任务的完成 Promise。
   */
  function enqueueConversationRun(key: string, task: () => Promise<void>): Promise<void> {
    const next = (conversationRunChains.get(key) ?? Promise.resolve()).then(task, task);
    conversationRunChains.set(key, next.catch(() => undefined));
    return next;
  }
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
    const traceStartedAt = now().toISOString();
    const trace = createObservableTraceRecorder(`trace_${runId}`, snapshot.requestId, [], traceStartedAt);
    const pacedTrace = dependencies.mockStepDelayMs
      ? createPacedTraceRecorder(trace, dependencies.mockStepDelayMs, controller.signal)
      : undefined;
    const executionTrace = pacedTrace ?? trace;
    const traceContext: TracePersistenceContext = {
      userId, runId, conversationId: snapshot.conversationId, traceId: trace.traceId,
      requestId: trace.requestId, startedAt: traceStartedAt
    };
    let tracePersistenceDegraded = false;
    let persistenceQueue = Promise.resolve();
    /** 将 Trace 旁路故障收敛为一次结构化告警，避免原始异常进入 Run result。 */
    const degradeTracePersistence = (): void => {
      if (tracePersistenceDegraded) return;
      tracePersistenceDegraded = true;
      dependencies.recordInternalWarning?.({
        code: "trace_persistence_degraded", runId, requestId: snapshot.requestId
      });
    };
    try {
      await dependencies.traceStore.initialize(traceContext);
    } catch {
      degradeTracePersistence();
    }
    const unsubscribe = trace.subscribe((event) => {
      if (tracePersistenceDegraded) return;
      persistenceQueue = persistenceQueue.then(async () => {
        const projection = await dependencies.traceStore.append(traceContext, event);
        if (!projection) {
          degradeTracePersistence();
          return;
        }
        dependencies.eventBus.publish(projection as AgentRunStreamEventDto);
      }).catch(() => {
        degradeTracePersistence();
      });
    });
    try {
      const runtime = dependencies.resolveModel(snapshot.modelId);
      if (!runtime) throw new RunModelNotFoundError(snapshot.modelId);
      const persistedAttachmentIds = await dependencies.store.listAttachmentDocumentIds(userId, runId) ?? [];
      const grounding = persistedAttachmentIds.length
        ? await retrieveAttachmentGrounding(
            dependencies.dataSourceRuntime,
            request.message.trim(),
            persistedAttachmentIds,
            userId,
            executionTrace
          )
        : undefined;
      // 会话历史内存累积：loop 保持纯函数（不就地改 history），
      // 本次 run 新消息由 executeAgentLoop 返回值带回，run 结束后追加再裁剪。
      const historyKey = `${userId}:${request.conversationId}`;
      let history = conversationHistories.get(historyKey);
      if (!history) {
        history = [];
        conversationHistories.set(historyKey, history);
      }
      const execution = await executeAgentLoop({
        message: request.message.trim(),
        reportMode: request.mode === "report",
        reportTriggerSource: request.mode === "report"
          ? request.source === "report_button" ? "button" : "toggle"
          : undefined,
        groundingContext: grounding?.context,
        groundingCitations: grounding?.citations,
        history,
        runtime,
        tools: dependencies.tools,
        signal: controller.signal,
        trace: executionTrace,
        maxTurns: dependencies.maxTurns,
        now
      });
      history.push(...execution.newMessages);
      trimConversationHistory(history);
      const workflow = await maybeRunReport(
        runId, userId, request.conversationId, execution.reportPlan, executionTrace, controller.signal, dependencies.sink
      );
      await pacedTrace?.flush();
      await persistenceQueue;
      if (!tracePersistenceDegraded) {
        try {
          await dependencies.traceStore.finalize(traceContext, trace.getTrace());
        } catch {
          degradeTracePersistence();
        }
      }
      if (execution.error?.code === "request_cancelled") {
        await publish(userId, runId, {
          type: "run_error",
          error: toRunError(undefined, snapshot.requestId, true)
        });
        return;
      }
      const result = redactSensitiveValue(toResponseDto(
        runId, execution, trace.getTrace(), request, snapshot.modelId, snapshot.requestId, workflow, tracePersistenceDegraded
      ));
      await publish(userId, runId, { type: "run_result", result });
    } catch (caught) {
      trace.record({
        type: "final_response",
        id: `${trace.traceId}_persistence_failure_terminal`,
        traceId: trace.traceId,
        requestId: trace.requestId,
        answerPreview: "",
        ok: false,
        error: {
          code: controller.signal.aborted ? "request_cancelled" : "internal_error",
          message: controller.signal.aborted ? "Agent run 已取消。" : "Agent run 执行失败。",
          stage: "final_response"
        },
        createdAt: now().toISOString()
      });
      await persistenceQueue;
      if (!tracePersistenceDegraded) {
        try {
          await dependencies.traceStore.finalize(traceContext, trace.getTrace());
        } catch {
          degradeTracePersistence();
        }
      }
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
      if (shuttingDown) throw new RunServiceShuttingDownError();
      const modelId = request.modelId ?? dependencies.defaultModelId ?? "mock";
      if (dependencies.hasModel && !dependencies.hasModel(modelId)) {
        throw new RunModelNotFoundError(modelId);
      }
      const runId = createId("run");
      // 浏览器幂等键按用户命名空间化，既满足全局唯一约束，也不会产生跨用户冲突侧信道。
      const requestId = request.clientMessageId
        ? `req_${createHash("sha256").update(`${userId}\0${request.clientMessageId}`).digest("hex")}`
        : createId("api_req");
      const createdAt = now().toISOString();
      const created = await dependencies.store.create({
        runId, requestId, userId, conversationId: request.conversationId,
        message: request.message.trim(), clientMessageId: request.clientMessageId ?? requestId,
        mode: request.mode, source: request.source, modelId,
        attachmentDocumentIds: request.attachmentDocumentIds ?? [],
        traceId: `trace_${runId}`, createdAt
      });
      const actual = created.snapshot;
      if (!created.created) return {
        runId: actual.runId, requestId: actual.requestId, conversationId: actual.conversationId,
        modelId: actual.modelId, status: actual.status,
        eventsUrl: `/api/runs/${actual.runId}/events`, snapshotUrl: `/api/runs/${actual.runId}`
      };
      dependencies.executionRegistry.create(runId);
      await publish(userId, runId, { type: "run_status", status: "queued", message: "研究任务已进入队列。" });
      dependencies.scheduler.schedule(() => enqueueConversationRun(
        `${userId}:${request.conversationId}`,
        () => execute(runId, request, userId)
      ));
      return {
        runId,
        requestId,
        conversationId: request.conversationId,
        modelId,
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
        // 取消必须发布 terminal error；仅发送状态事件会让 SSE 消费端继续等待。
        await publish(userId, runId, {
          type: "run_error",
          error: {
            code: "request_cancelled",
            message: "用户已停止本次生成。",
            requestId: snapshot.requestId
          }
        });
      }
      return dependencies.store.findById(userId, runId);
    },
    listEvents: (userId, runId, afterSequence) => dependencies.store.listEvents(userId, runId, afterSequence),
    subscribe: (runId, listener) => dependencies.eventBus.subscribe(runId, listener),
    recoverStale,
    isShuttingDown: () => shuttingDown,
    async shutdown({ drainMs }) {
      shuttingDown = true;
      // 先中断在途执行，执行体观察到 abort 后自行走取消收尾并退出 registry。
      for (const runId of dependencies.executionRegistry.list()) {
        dependencies.executionRegistry.get(runId)?.abort();
      }
      const deadline = Date.now() + drainMs;
      while (dependencies.executionRegistry.list().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // drain 窗口内仍未终态的 Run 统一落库为可解释的 interrupted，与重启恢复语义一致。
      const interrupted = await recoverStale(now().toISOString());
      return { interrupted };
    }
  };
}

/**
 * 只从本轮附件构造 grounding context，并把 RAG trace 归一到当前 Run。
 *
 * @param runtime RAG runtime。
 * @param question 用户问题。
 * @param documentIds 本轮附件文档。
 * @param userId 当前用户。
 * @param trace 当前 Run trace recorder。
 * @returns 模型上下文与引用。
 */
async function retrieveAttachmentGrounding(
  runtime: DataSourceRuntime | undefined,
  question: string,
  documentIds: string[],
  userId: string,
  trace: ReturnType<typeof createObservableTraceRecorder>
): Promise<{ context: string; citations: CitationDto[] }> {
  if (!runtime) throw new Error("Attachment retrieval runtime is not configured.");
  const result = await runtime.search(question, {
    topK: 5,
    filter: { documentIds }
  }, { ownerUserId: userId });
  if (!result.ok) throw new Error(result.error.message);
  trace.record({
    ...result.data.trace,
    id: `${trace.traceId}_attachment_retrieval`,
    traceId: trace.traceId,
    requestId: trace.requestId
  });
  return {
    context: result.data.results.map((item, index) =>
      `[${index + 1}] ${item.citation.heading ?? item.citation.source}\n${item.text}`
    ).join("\n\n"),
    citations: result.data.results.map((item) => item.citation)
  };
}

/** shutdown 期间拒绝新 Run 的结构化错误；API 层映射为 503，不泄漏内部状态。 */
export class RunServiceShuttingDownError extends Error {
  constructor() {
    super("Run service is shutting down.");
    this.name = "RunServiceShuttingDownError";
  }
}

/** 请求引用了服务端目录之外的模型；route 将其映射为稳定 validation_failed。 */
export class RunModelNotFoundError extends Error {
  /** @param modelId 非法或不可用模型 ID。 */
  constructor(readonly modelId: string) {
    super(`Model is not available: ${modelId}`);
    this.name = "RunModelNotFoundError";
  }
}

/**
 * report plan ready 时编排 report workflow（plan 由 agent-execution 生成）。
 *
 * @returns workflow DTO；plan 未就绪或已取消时返回 undefined。
 */
async function maybeRunReport(
  runId: string,
  userId: string,
  conversationId: string,
  plan: ReportPlanDto | undefined,
  trace: ReturnType<typeof createObservableTraceRecorder>,
  signal: AbortSignal,
  sink: RunServiceSink
): Promise<ReportWorkflowResponseDto | undefined> {
  if (plan?.status !== "ready" || signal.aborted) return undefined;
  const result = await runReportWorkflow(plan, {
    documents: createReportDemoDocuments(),
    trace,
    signal
  });
  const workflow = redactSensitiveValue(toWorkflowDto(result));
  const context = { userId, conversationId, agentRunId: runId, planId: plan.planId };
  if (workflow.run.approvalRequest && !workflow.run.approvalRequest.inputDigest) {
    // workflow 审批（如 PDF exporter）由 workflow 包生成，不经过 tools executor，原生没有 inputDigest。
    // 必须在 saveWorkflow 之前补齐确定性 digest：客户端从 workflow DTO 读取该 digest 调 decision
    // endpoint，而 endpoint schema 要求非空 digest——缺了它审批永远无法决定，PDF 导出会回归。
    workflow.run.approvalRequest.inputDigest = createWorkflowApprovalDigest(
      workflow.run.approvalRequest.toolName,
      workflow.run.runId,
      `artifact_${workflow.run.runId}`
    );
  }
  await sink.saveWorkflow(workflow, context);
  if (workflow.run.approvalRequest) await sink.saveApproval(workflow.run.approvalRequest, { runId, userId });
  if (workflow.artifact) await sink.saveArtifact(workflow.artifact, context);
  return workflow;
}

/**
 * 把 loop 执行结果组装为对外 Run result DTO。
 *
 * @returns 脱敏前的 AgentRunResponseDto。
 */
function toResponseDto(
  runId: string,
  execution: AgentExecutionResult,
  trace: TraceDto,
  request: AgentRunCreateRequestDto,
  modelId: string,
  requestId: string,
  reportWorkflow: ReportWorkflowResponseDto | undefined,
  tracePersistenceDegraded: boolean
): AgentRunResponseDto {
  return {
    runId,
    conversationId: request.conversationId,
    modelId,
    requestId,
    traceId: trace.traceId,
    ok: execution.ok,
    intent: execution.intent,
    answer: execution.answer,
    citations: execution.citations,
    steps: execution.steps,
    trace,
    tracePersistence: tracePersistenceDegraded
      ? {
          status: "degraded",
          diagnostic: {
            code: "trace_persistence_degraded",
            message: "Trace 持久化暂时不可用；Agent 主结果已保留。"
          }
        }
      : { status: "complete" },
    reportPlan: execution.reportPlan,
    reportWorkflow,
    error: execution.error ? {
      code: "agent_failed",
      message: execution.error.message,
      requestId,
      details: { agentCode: execution.error.code, mode: request.mode, ...execution.error.details }
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

/**
 * 为 workflow 审批生成确定性输入摘要；风格与 tools executor 的 createInputDigest 一致，
 * 对规范化序列化做 SHA-256 并截取前缀，不保存原文。
 *
 * @param toolName 工具名称。
 * @param workflowRunId workflow run 标识。
 * @param artifactId 导出目标 artifact 标识。
 * @returns `input_` 前缀的稳定摘要。
 */
function createWorkflowApprovalDigest(toolName: string, workflowRunId: string, artifactId: string): string {
  const serialized = JSON.stringify({ artifactId, toolName, workflowRunId });
  return `input_${createHash("sha256").update(serialized).digest("hex").slice(0, 16)}`;
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
