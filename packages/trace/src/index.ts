export interface TraceSummary {
  packageName: string;
  eventCount: number;
}

export interface Trace {
  traceId: string;
  requestId: string;
  startedAt: string;
  completedAt?: string;
  summary: TraceRunSummary;
  events: TraceEvent[];
}

export type TraceTokenCount = number | "unknown";

export interface TraceRunSummary {
  status: "running" | "succeeded" | "failed";
  durationMs: number;
  modelCallCount: number;
  toolCallCount: number;
  retrievalCount: number;
  inputTokens: TraceTokenCount;
  outputTokens: TraceTokenCount;
  knownTokenTotal: number;
  unknownTokenCallCount: number;
  errorCount: number;
}

export type TraceEventType =
  | "request_received"
  | "intent_routed"
  | "agent_step"
  | "approval"
  | "security"
  | "retrieval"
  | "report_skill_activation"
  | "report_plan"
  | "workflow_node"
  | "citation_verifier"
  | "pdf_export"
  | "model_call"
  | "tool_call"
  | "mcp_tool_discovered"
  | "mcp_tool_call"
  | "final_response";

export interface TraceError {
  code: string;
  message: string;
  stage?: string;
  details?: Record<string, unknown>;
}

interface TraceEventBase {
  type: TraceEventType;
  id: string;
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  stage?: string;
  createdAt: string;
}

export interface TraceRequestReceivedEvent extends TraceEventBase {
  type: "request_received";
  userMessage: string;
  inputPreview: string;
}

export interface TraceIntentRoutedEvent extends TraceEventBase {
  type: "intent_routed";
  intent: string;
  confidence: number;
  reason: string;
  toolName?: string;
}

export interface TraceAgentStepEvent extends TraceEventBase {
  type: "agent_step";
  stepIndex: number;
  stepType: string;
  status: "started" | "succeeded" | "failed";
  durationMs: number;
  error?: TraceError;
  data?: Record<string, unknown>;
}

export interface TraceApprovalEvent extends TraceEventBase {
  type: "approval";
  approvalId: string;
  toolName: string;
  status: "requested" | "approved" | "rejected";
  reason: string;
  inputPreview: unknown;
  reviewerNote?: string;
  inputDigest?: string;
  reasonCode?: string;
}

export type SecurityDecision = "allow" | "downrank" | "require_confirmation" | "block";

export interface TraceSecurityEvent extends TraceEventBase {
  type: "security";
  category: "prompt_injection" | "tool_permission" | "sql_readonly" | "pii_redaction";
  decision: SecurityDecision;
  reasonCode: string;
  sourceType?: string;
  redactionCount?: number;
}

export interface TraceRetrievalScoreSummary {
  chunkId: string;
  documentId?: string;
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
  rerankScore?: number;
  finalScore: number;
  rank: number;
}

export interface TraceRetrievalEvent extends TraceEventBase {
  type: "retrieval";
  queryPreview: string;
  mode: "vector" | "keyword" | "hybrid";
  topK: number;
  candidateLimit: number;
  durationMs: number;
  chunkIds: string[];
  scoreSummary: TraceRetrievalScoreSummary[];
  ok: boolean;
  error?: TraceError;
}

export type ReportTriggerSource = "toggle" | "button" | "natural_language";

export type ReportPlanStatus = "ready" | "needs_clarification" | "partial";

export type ReportType = "company_brief" | "earnings_review" | "risk_review" | "custom";

export type ReportPlanStepKind =
  | "clarify_requirements"
  | "collect_filings"
  | "collect_financial_metrics"
  | "retrieve_evidence"
  | "analyze_findings"
  | "draft_report"
  | "review_citations"
  | "prepare_export";

export interface ReportPlannerInputTracePayload {
  message: string;
  triggerSource: ReportTriggerSource;
  reportMode: boolean;
  matchedRules: string[];
  routeReason: string;
}

export interface ReportPlanStepTracePayload {
  id: string;
  kind: ReportPlanStepKind;
  title: string;
  description: string;
  requiredData: string[];
  optional: boolean;
}

export interface ReportPlanTracePayload {
  planId: string;
  status: ReportPlanStatus;
  triggerSource: ReportTriggerSource;
  reportType: ReportType;
  subject?: string;
  timeRange?: string;
  requiredData: string[];
  assumptions: string[];
  clarificationQuestions: string[];
  steps: ReportPlanStepTracePayload[];
}

export interface TraceReportSkillActivationEvent extends TraceEventBase {
  type: "report_skill_activation";
  triggerSource: ReportTriggerSource;
  routeReason: string;
  matchedRules: string[];
  plannerInput: ReportPlannerInputTracePayload;
}

export interface TraceReportPlanEvent extends TraceEventBase {
  type: "report_plan";
  plan: ReportPlanTracePayload;
  assumptions: string[];
  ok: boolean;
  error?: TraceError;
}

export type WorkflowNodeStatus = "pending" | "running" | "paused" | "approved" | "rejected" | "succeeded" | "failed" | "skipped";

export type WorkflowErrorCode =
  | "invalid_workflow"
  | "invalid_node_input"
  | "invalid_node_output"
  | "node_execution_failed"
  | "node_timeout"
  | "workflow_deadline_exceeded"
  | "workflow_cancelled"
  | "retry_exhausted"
  | "max_steps_exceeded"
  | "approval_required"
  | "approval_rejected";

export interface WorkflowTraceError {
  code: WorkflowErrorCode;
  message: string;
  stage?: string;
  nodeId?: string;
  details?: Record<string, unknown>;
}

export interface TraceWorkflowNodeEvent extends TraceEventBase {
  type: "workflow_node";
  workflowRunId: string;
  nodeId: string;
  nodeType: string;
  status: WorkflowNodeStatus;
  durationMs: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: WorkflowTraceError;
}

export interface TraceCitationVerifierEvent extends TraceEventBase {
  type: "citation_verifier";
  workflowRunId: string;
  decision: "pass" | "needs_more_evidence" | "needs_metric" | "retry_tool" | "fail";
  retryCount: number;
  missingClaimCount: number;
  missingMetricCount: number;
  durationMs: number;
  ok: boolean;
  error?: TraceError;
}

export interface TracePdfExportEvent extends TraceEventBase {
  type: "pdf_export";
  workflowRunId: string;
  status: "queued" | "started" | "succeeded" | "failed" | "not_implemented";
  fileName?: string;
  durationMs: number;
  error?: TraceError;
}

export interface TraceModelCallEvent extends TraceEventBase {
  type: "model_call";
  model: string;
  purpose: string;
  durationMs: number;
  ok: boolean;
  attempt?: number;
  modelAttempt?: number;
  fallbackIndex?: number;
  fallbackReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: TraceError;
}

export interface TraceToolCallEvent extends TraceEventBase {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  attempts?: number;
  error?: TraceError;
}

export interface TraceMcpToolDiscoveredEvent extends TraceEventBase {
  type: "mcp_tool_discovered";
  serverName: string;
  toolNames: string[];
  ok: boolean;
  durationMs: number;
  error?: TraceError;
}

export interface TraceMcpToolCallEvent extends TraceEventBase {
  type: "mcp_tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  attempts?: number;
  error?: TraceError;
}

export interface TraceFinalResponseEvent extends TraceEventBase {
  type: "final_response";
  answerPreview: string;
  ok: boolean;
  error?: TraceError;
}

export type TraceEvent =
  | TraceRequestReceivedEvent
  | TraceIntentRoutedEvent
  | TraceAgentStepEvent
  | TraceApprovalEvent
  | TraceSecurityEvent
  | TraceRetrievalEvent
  | TraceReportSkillActivationEvent
  | TraceReportPlanEvent
  | TraceWorkflowNodeEvent
  | TraceCitationVerifierEvent
  | TracePdfExportEvent
  | TraceModelCallEvent
  | TraceToolCallEvent
  | TraceMcpToolDiscoveredEvent
  | TraceMcpToolCallEvent
  | TraceFinalResponseEvent;

export interface TraceRecorder {
  readonly traceId: string;
  readonly requestId: string;
  /**
   * 记录单个 trace event，调用方不需要知道 recorder 的存储细节。
   *
   * @param event 要追加到当前 trace 的事件。
   */
  record(event: TraceEvent): void;
  /**
   * 读取当前 trace 的事件快照，避免外部直接修改内部数组。
   *
   * @returns 当前 trace 下的事件列表。
   */
  getEvents(): TraceEvent[];
  /**
   * 读取可直接返回前端的一次请求 trace 快照。
   *
   * @returns 包含 request id 和事件时间线的 trace。
   */
  getTrace(): Trace;
}

export interface TraceStore {
  save(trace: Trace): void;
  getByRequestId(requestId: string): Trace | undefined;
}

/**
 * 创建 trace 摘要，当前用于验证 trace package 边界已经可被其他 package 引用。
 *
 * @returns trace package 的最小摘要信息。
 */
export function createTraceSummary(): TraceSummary {
  return {
    packageName: "@aiagent/trace",
    eventCount: 0
  };
}

/**
 * 创建内存 trace recorder，供本地开发、mock 工具和后续前端 timeline 消费。
 *
 * @param traceId 一次请求或一次手动验证的稳定 trace 标识。
 * @param requestId 对外请求标识，默认与 traceId 一起生成，便于 Week 4 接入 API 网关。
 * @returns 可记录并读取事件的内存 recorder。
 */
export function createInMemoryTraceRecorder(traceId = createTraceId(), requestId = createRequestId(), initialEvents: readonly TraceEvent[] = [], initialStartedAt?: string): TraceRecorder {
  const events: TraceEvent[] = initialEvents.map(sanitizeTraceEvent);
  const startedAt = initialStartedAt ?? new Date().toISOString();

  /**
   * 追加单个 trace event，保持 recorder 实现对调用方透明。
   *
   * @param event 要记录的事件。
   */
  function record(event: TraceEvent): void {
    const spanId = event.spanId ?? (event.type === "request_received" ? `${traceId}_root` : `${event.id}_span`);
    const parentSpanId = event.parentSpanId ?? (event.type === "request_received" ? undefined : `${traceId}_root`);
    events.push(sanitizeTraceEvent({ ...event, spanId, parentSpanId }));
  }

  /**
   * 返回事件快照，避免调用方修改 recorder 内部状态。
   *
   * @returns 当前 trace 的事件列表。
   */
  function getEvents(): TraceEvent[] {
    return [...events];
  }

  /**
   * 返回一次请求的完整 trace 快照，前端只消费这个稳定结构。
   *
   * @returns 当前 trace 快照。
   */
  function getTrace(): Trace {
    const summary = summarizeTrace(events, startedAt);
    return {
      traceId,
      requestId,
      startedAt,
      completedAt: summary.status === "running" ? undefined : latestCreatedAt(events),
      summary,
      events: getEvents()
    };
  }

  return {
    traceId,
    requestId,
    record,
    getEvents,
    getTrace
  };
}

/**
 * 从事件明细计算请求级指标；未知 token 独立计数，避免把未知成本伪装成零。
 *
 * @param events 当前请求事件。
 * @param startedAt 请求开始时间。
 * @returns 与明细一致的运行汇总。
 */
export function summarizeTrace(events: readonly TraceEvent[], startedAt: string): TraceRunSummary {
  const modelEvents = events.filter((event): event is TraceModelCallEvent => event.type === "model_call");
  const input = sumKnownTokens(modelEvents.map((event) => event.usage?.promptTokens));
  const output = sumKnownTokens(modelEvents.map((event) => event.usage?.completionTokens));
  const final = [...events].reverse().find((event): event is TraceFinalResponseEvent => event.type === "final_response");
  const end = latestCreatedAt(events);
  return {
    status: final ? (final.ok ? "succeeded" : "failed") : "running",
    durationMs: end ? Math.max(0, Date.parse(end) - Date.parse(startedAt)) : 0,
    modelCallCount: modelEvents.length,
    toolCallCount: events.filter((event) => event.type === "tool_call" || event.type === "mcp_tool_call").length,
    retrievalCount: events.filter((event) => event.type === "retrieval").length,
    inputTokens: input.unknown ? "unknown" : input.total,
    outputTokens: output.unknown ? "unknown" : output.total,
    knownTokenTotal: input.total + output.total,
    unknownTokenCallCount: modelEvents.filter((event) => event.usage?.promptTokens === undefined || event.usage?.completionTokens === undefined).length,
    errorCount: events.filter(hasTraceError).length
  };
}

/** 创建进程内 requestId 索引；本任务不承诺长期持久化。 */
export function createInMemoryTraceStore(): TraceStore {
  const traces = new Map<string, Trace>();
  return {
    save(trace) { traces.set(trace.requestId, sanitizeValue(trace) as Trace); },
    getByRequestId(requestId) { const trace = traces.get(requestId); return trace ? structuredClone(trace) : undefined; }
  };
}

function sumKnownTokens(values: readonly (number | undefined)[]): { total: number; unknown: boolean } {
  return { total: values.reduce<number>((sum, value) => sum + (value ?? 0), 0), unknown: values.some((value) => value === undefined) };
}

function hasTraceError(event: TraceEvent): boolean {
  return ("ok" in event && event.ok === false) || ("status" in event && (event.status === "failed" || event.status === "rejected"));
}

function latestCreatedAt(events: readonly TraceEvent[]): string | undefined {
  return events.reduce<string | undefined>((latest, event) => !latest || event.createdAt > latest ? event.createdAt : latest, undefined);
}

/**
 * 生成轻量 trace id，避免引入运行时依赖并保持浏览器/Node 都可用。
 *
 * @returns 带 trace_ 前缀的请求链路标识。
 */
export function createTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成轻量 request id，后续可替换为 API 网关传入的请求标识。
 *
 * @returns 带 req_ 前缀的请求标识。
 */
export function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 对 trace event 做集中脱敏，避免工具参数或错误 details 意外携带密钥。
 *
 * @param event 原始 trace event。
 * @returns 脱敏后的 trace event。
 */
function sanitizeTraceEvent(event: TraceEvent): TraceEvent {
  const withStage = "error" in event && event.error
    ? { ...event, stage: event.stage ?? event.type, error: { ...event.error, stage: event.error.stage ?? event.stage ?? event.type } }
    : event;
  return sanitizeValue(withStage) as TraceEvent;
}

/**
 * 递归复制并脱敏对象，保持 recorder 外部传入对象不会被修改。
 *
 * @param value 未信任的 trace 字段值。
 * @returns 可安全保存在 trace 中的值。
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === "string") {
    return truncate(redactSensitiveText(value));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(child);
  }

  return sanitized;
}

const MAX_TRACE_STRING_LENGTH = 500;

function truncate(value: string): string {
  return value.length <= MAX_TRACE_STRING_LENGTH ? value : `${value.slice(0, MAX_TRACE_STRING_LENGTH)}…[truncated]`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk[-_][A-Za-z0-9_-]{12,}|api[-_]?key[-_][A-Za-z0-9_-]{12,})\b/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted:email]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)(?!\s*(?:CNY|RMB|元|万元|亿元|%|股))/g, "[redacted:phone]")
    .replace(/(?<![A-Z0-9])\d{17}[0-9Xx](?![A-Z0-9])/g, "[redacted:id]")
    .replace(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, "[redacted:account]");
}

/**
 * 在日志、API 错误和报告输出边界复用与 trace 相同的递归脱敏策略。
 *
 * @template TValue 输入值类型。
 * @param value 可能包含 PII 或 secret 的值。
 * @returns 深拷贝后的脱敏值。
 */
export function redactSensitiveValue<TValue>(value: TValue): TValue {
  return sanitizeValue(value) as TValue;
}

/**
 * 识别常见敏感字段名，避免 API key、token、密码或 Authorization 头进入 trace。
 *
 * @param key 对象字段名。
 * @returns 是否应脱敏。
 */
function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|password|secret|(^|[-_])(access[-_]?token|refresh[-_]?token|token)($|[-_])/i.test(key);
}
