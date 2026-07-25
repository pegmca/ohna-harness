export type ISODateTimeString = string;

export type RequestId = string;
export type UserId = string;

export interface QqIdentityDto {
  botAccountId: string;
  boundAt: ISODateTimeString;
}

export interface IdentityMeDto {
  userId: UserId;
  createdAt: ISODateTimeString;
  qqIdentity?: QqIdentityDto;
  qqBot: {
    enabled: boolean;
    status: "disabled" | "starting" | "connected" | "reconnecting" | "failed" | "stopped";
  };
}

export interface IdentityBootstrapRequestDto {
  visitorId: string;
  fingerprintVersion: string;
}

export interface QqBindingChallengeDto {
  challengeId: string;
  code: string;
  command: string;
  expiresAt: ISODateTimeString;
  botQrUrl?: string;
}

export interface QqBindingStatusDto {
  challengeId: string;
  status: "pending" | "bound" | "expired" | "failed";
  qqIdentity?: QqIdentityDto;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation_failed"
  | "agent_failed"
  | "tool_failed"
  | "trace_failed"
  | "request_cancelled"
  | "run_interrupted"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  requestId?: RequestId;
  details?: Record<string, unknown>;
}

export interface ApiSuccess<TData> {
  ok: true;
  data: TData;
  requestId: RequestId;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  requestId: RequestId;
}

export type ApiResult<TData> = ApiSuccess<TData> | ApiFailure;

export type ResearchMode = "chat" | "report";

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: ISODateTimeString;
}

export type AgentIntentDto = "chat" | "tool" | "report_skill";

export type AgentStepStatusDto = "succeeded" | "failed";

export interface AgentStepDto {
  index: number;
  type: string;
  status: AgentStepStatusDto;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: ApiError;
}

export interface TraceErrorDto {
  code: string;
  message: string;
  stage?: string;
  details?: Record<string, unknown>;
}

export interface TraceDto {
  traceId: string;
  requestId: string;
  startedAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
  summary: TraceRunSummaryDto;
  events: TraceEventDto[];
}

export interface TraceRunSummaryDto {
  status: "running" | "succeeded" | "failed";
  durationMs: number;
  modelCallCount: number;
  toolCallCount: number;
  retrievalCount: number;
  inputTokens: number | "unknown";
  outputTokens: number | "unknown";
  knownTokenTotal: number;
  unknownTokenCallCount: number;
  errorCount: number;
}

export type ToolPermissionLevelDto = "safe" | "needs_approval" | "blocked";

export type ToolApprovalDecisionValueDto = "approved" | "rejected";

export interface ToolApprovalRequestDto {
  approvalId: string;
  traceId: string;
  toolName: string;
  reason: string;
  inputPreview: unknown;
  permissionLevel: ToolPermissionLevelDto;
  /** 绑定原始请求和规范化输入，防止旧审批被挪用到另一笔调用。 */
  requestId?: string;
  inputDigest?: string;
  reasonCode?: string;
}

export interface ToolApprovalDecisionDto {
  approvalId: string;
  decision: ToolApprovalDecisionValueDto;
  reviewerNote?: string;
  requestId?: string;
  inputDigest?: string;
}

export type SecurityDecisionDto = "allow" | "downrank" | "require_confirmation" | "block";

export interface TraceSecurityEventDto extends TraceEventBaseDto {
  type: "security";
  category: "prompt_injection" | "tool_permission" | "sql_readonly" | "pii_redaction";
  decision: SecurityDecisionDto;
  reasonCode: string;
  sourceType?: string;
  redactionCount?: number;
}

export type TraceEventDto =
  | TraceRequestReceivedEventDto
  | TraceIntentRoutedEventDto
  | TraceAgentStepEventDto
  | TraceApprovalEventDto
  | TraceSecurityEventDto
  | TraceRetrievalEventDto
  | TraceReportSkillActivationEventDto
  | TraceReportPlanEventDto
  | TraceWorkflowNodeEventDto
  | TraceCitationVerifierEventDto
  | TracePdfExportEventDto
  | TraceModelCallEventDto
  | TraceToolCallEventDto
  | TraceMcpToolDiscoveredEventDto
  | TraceMcpToolCallEventDto
  | TraceFinalResponseEventDto;

export interface TraceEventBaseDto {
  type: string;
  id: string;
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  stage?: string;
  createdAt: ISODateTimeString;
}

export interface TraceRequestReceivedEventDto extends TraceEventBaseDto {
  type: "request_received";
  userMessage: string;
  inputPreview: string;
}

export interface TraceIntentRoutedEventDto extends TraceEventBaseDto {
  type: "intent_routed";
  intent: string;
  confidence: number;
  reason: string;
  toolName?: string;
}

export interface TraceAgentStepEventDto extends TraceEventBaseDto {
  type: "agent_step";
  stepIndex: number;
  stepType: string;
  status: "started" | "succeeded" | "failed";
  durationMs: number;
  data?: Record<string, unknown>;
  error?: TraceErrorDto;
}

export interface TraceApprovalEventDto extends TraceEventBaseDto {
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

export interface TraceRetrievalScoreSummaryDto {
  chunkId: string;
  documentId?: string;
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
  rerankScore?: number;
  finalScore: number;
  rank: number;
}

export interface TraceRetrievalEventDto extends TraceEventBaseDto {
  type: "retrieval";
  queryPreview: string;
  mode: "vector" | "keyword" | "hybrid";
  topK: number;
  candidateLimit: number;
  durationMs: number;
  chunkIds: string[];
  scoreSummary: TraceRetrievalScoreSummaryDto[];
  ok: boolean;
  error?: TraceErrorDto;
}

export interface TraceReportSkillActivationEventDto extends TraceEventBaseDto {
  type: "report_skill_activation";
  triggerSource: ReportTriggerSourceDto;
  routeReason: string;
  matchedRules: string[];
  plannerInput: ReportPlannerInputDto;
}

export interface TraceReportPlanEventDto extends TraceEventBaseDto {
  type: "report_plan";
  plan: ReportPlanDto;
  assumptions: string[];
  ok: boolean;
  error?: TraceErrorDto;
}

export interface TraceWorkflowNodeEventDto extends TraceEventBaseDto {
  type: "workflow_node";
  workflowRunId: string;
  nodeId: string;
  nodeType: string;
  status: WorkflowNodeStatusDto;
  durationMs: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: WorkflowErrorDto;
}

export interface TraceCitationVerifierEventDto extends TraceEventBaseDto {
  type: "citation_verifier";
  workflowRunId: string;
  decision: "pass" | "needs_more_evidence" | "needs_metric" | "retry_tool" | "fail";
  retryCount: number;
  missingClaimCount: number;
  missingMetricCount: number;
  durationMs: number;
  ok: boolean;
  error?: TraceErrorDto;
}

export interface TracePdfExportEventDto extends TraceEventBaseDto {
  type: "pdf_export";
  workflowRunId: string;
  status: "queued" | "started" | "succeeded" | "failed" | "not_implemented";
  fileName?: string;
  durationMs: number;
  error?: TraceErrorDto;
}

export interface TraceModelCallEventDto extends TraceEventBaseDto {
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
  error?: TraceErrorDto;
}

export interface TraceToolCallEventDto extends TraceEventBaseDto {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  attempts?: number;
  error?: TraceErrorDto;
}

export interface TraceMcpToolDiscoveredEventDto extends TraceEventBaseDto {
  type: "mcp_tool_discovered";
  serverName: string;
  toolNames: string[];
  ok: boolean;
  durationMs: number;
  error?: TraceErrorDto;
}

export interface TraceMcpToolCallEventDto extends TraceEventBaseDto {
  type: "mcp_tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  attempts?: number;
  error?: TraceErrorDto;
}

export interface TraceFinalResponseEventDto extends TraceEventBaseDto {
  type: "final_response";
  answerPreview: string;
  ok: boolean;
  error?: TraceErrorDto;
}

/** 创建研究 Run 的请求；显式模式与触发入口分离，避免 UI 泄漏 Agent 路由细节。 */
export interface AgentRunCreateRequestDto {
  message: string;
  conversationId: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
  clientMessageId?: string;
}

/** Agent runtime 内部兼容请求；浏览器创建新 Run 时使用 AgentRunCreateRequestDto。 */
export interface AgentRunRequestDto {
  message: string;
  reportMode?: boolean;
  reportTriggerSource?: ReportTriggerSourceDto;
  conversationId?: string;
}

/** 绑定到 URL 中 run 与 approval 资源的最小人工审批输入。 */
export interface RunApprovalDecisionRequestDto {
  decision: "approved" | "rejected";
  reviewerNote?: string;
  inputDigest: string;
}

export interface AgentRunResponseDto {
  runId: string;
  conversationId: string;
  requestId: string;
  traceId: string;
  ok: boolean;
  intent: AgentIntentDto;
  answer: string;
  steps: AgentStepDto[];
  trace: TraceDto;
  reportPlan?: ReportPlanDto;
  reportWorkflow?: ReportWorkflowResponseDto;
  error?: ApiError;
}

/** 异步研究任务的生命周期状态，供 HTTP snapshot 与 SSE 共同使用。 */
export type AgentRunStatusDto = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

/** 创建异步 Agent run 后立即返回的定位信息。 */
export interface AgentRunAcceptedDto {
  runId: string;
  requestId: string;
  conversationId: string;
  status: AgentRunStatusDto;
  eventsUrl: string;
  snapshotUrl: string;
}

/** SSE 使用的稳定事件 envelope；sequence 同时作为 SSE id 支持断线重放。 */
export type AgentRunStreamEventDto =
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_status";
      status: AgentRunStatusDto;
      message: string;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "trace_event";
      event: TraceEventDto;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_result";
      result: AgentRunResponseDto;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_error";
      error: ApiError;
    };

/** 持久化 adapter 分配 eventId/sequence 前的 canonical event 输入。 */
export type AgentRunEventInputDto =
  AgentRunStreamEventDto extends infer TEvent
    ? TEvent extends AgentRunStreamEventDto
      ? Omit<TEvent, "eventId" | "sequence">
      : never
    : never;

/** 供刷新和 SSE 断线恢复使用的 run 快照。 */
export interface AgentRunSnapshotDto {
  runId: string;
  requestId: string;
  conversationId: string;
  status: AgentRunStatusDto;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  events: AgentRunStreamEventDto[];
  result?: AgentRunResponseDto;
  error?: ApiError;
}

/** 单根 K 线的稳定行情传输结构。 */
export interface MarketBarDto {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 行情时序 contract 与 provider 解耦，UI 不依赖具体工具实现。 */
export interface MarketSeriesDto {
  ticker: string;
  exchange: string;
  currency: string;
  timezone: string;
  interval: "1d";
  range: "3m";
  source: "mock";
  asOf: ISODateTimeString;
  bars: MarketBarDto[];
}

export type ReportArtifactStatusDto = "html_preview_only" | "pdf_ready" | "pdf_failed";
export type ReportPdfExportStatusDto = "queued" | "ready" | "failed";

export interface ReportCitationDto {
  id: string;
  claimId?: string;
  supportsFinding: string;
  quote: string;
  source: string;
  documentId?: string;
  chunkId?: string;
  chunkIndex?: number;
  heading?: string;
}

/** Web 只消费报告 artifact DTO，不依赖 report package 的内部 workflow state。 */
export interface ReportArtifactDto {
  artifactId: string;
  reportId: string;
  workflowRunId: string;
  status: ReportArtifactStatusDto;
  title: string;
  markdown: string;
  html: string;
  citations: ReportCitationDto[];
  citationVerification: {
    decision: "pass" | "needs_more_evidence" | "needs_metric" | "retry_tool" | "fail";
    verified: boolean;
    missingClaims: string[];
    missingMetrics: string[];
  };
  pdfExport: {
    status: ReportPdfExportStatusDto;
    fileName?: string;
    message: string;
    generatedAt?: ISODateTimeString;
    downloadUrl?: string;
    error?: ApiError;
  };
  createdAt: ISODateTimeString;
}

/** Eval 展示 DTO 来自版本化 baseline/current 报告，而不是由浏览器计算。 */
export interface ProductEvalReportDto {
  datasetVersion: string;
  caseCount: number;
  generatedAt: ISODateTimeString;
  metrics: Record<string, number>;
  baseline: Record<string, number>;
  failures: Array<{
    caseId: string;
    query: string;
    rootCause: string;
    improvement: string;
    traceId: string;
    requestId: string;
  }>;
  demoData: true;
}

/** 产品架构 DTO 让 Web 展示与仓库真实 package 边界保持同步。 */
export interface ProductArchitectureDto {
  nodes: Array<{ id: string; label: string; responsibility: string }>;
  edges: Array<{ from: string; to: string; label: string }>;
  demoData: false;
}

export interface ReportWorkflowResponseDto {
  run: WorkflowRunDto;
  artifact?: ReportArtifactDto;
}

export interface StartReportWorkflowRequestDto {
  plan: ReportPlanDto;
}

export type ReportTriggerSourceDto = "toggle" | "button" | "natural_language";

export type ReportPlanStatusDto = "ready" | "needs_clarification" | "partial";

export type ReportTypeDto = "company_brief" | "earnings_review" | "risk_review" | "custom";

export type ReportPlanStepKindDto =
  | "clarify_requirements"
  | "collect_filings"
  | "collect_financial_metrics"
  | "retrieve_evidence"
  | "analyze_findings"
  | "draft_report"
  | "review_citations"
  | "prepare_export";

export interface ReportPlannerInputDto {
  message: string;
  triggerSource: ReportTriggerSourceDto;
  reportMode: boolean;
  matchedRules: string[];
  routeReason: string;
}

export interface ReportPlanStepDto {
  id: string;
  kind: ReportPlanStepKindDto;
  title: string;
  description: string;
  requiredData: string[];
  optional: boolean;
}

export interface ReportPlanDto {
  planId: string;
  status: ReportPlanStatusDto;
  triggerSource: ReportTriggerSourceDto;
  reportType: ReportTypeDto;
  subject?: string;
  timeRange?: string;
  requiredData: string[];
  assumptions: string[];
  clarificationQuestions: string[];
  steps: ReportPlanStepDto[];
}

export type WorkflowRunStatusDto = "pending" | "running" | "paused" | "approved" | "rejected" | "succeeded" | "failed";

export type WorkflowNodeStatusDto = "pending" | "running" | "paused" | "approved" | "rejected" | "succeeded" | "failed" | "skipped";

export type WorkflowErrorCodeDto =
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

export interface WorkflowErrorDto {
  code: WorkflowErrorCodeDto;
  message: string;
  nodeId?: string;
  details?: Record<string, unknown>;
}

export interface WorkflowNodeDto {
  nodeId: string;
  type: string;
  title: string;
  status: WorkflowNodeStatusDto;
  startedAt?: ISODateTimeString;
  completedAt?: ISODateTimeString;
  durationMs: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: WorkflowErrorDto;
}

export interface WorkflowEdgeDto {
  from: string;
  to: string;
}

export interface WorkflowEventDto {
  id: string;
  type:
    | "node_started"
    | "node_succeeded"
    | "node_failed"
    | "node_paused"
    | "node_approved"
    | "node_rejected"
    | "workflow_paused"
    | "workflow_approved"
    | "workflow_rejected"
    | "workflow_failed"
    | "workflow_succeeded";
  nodeId?: string;
  createdAt: ISODateTimeString;
  data?: Record<string, unknown>;
  error?: WorkflowErrorDto;
}

export interface WorkflowRunDto {
  runId: string;
  workflowName: string;
  status: WorkflowRunStatusDto;
  startedAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
  durationMs: number;
  maxSteps: number;
  executedSteps: number;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  events: WorkflowEventDto[];
  approvalRequest?: ToolApprovalRequestDto;
  error?: WorkflowErrorDto;
  partial?: boolean;
  recovery?: Array<{ nodeId: string; action: "retried" | "skipped" | "partial"; attempts: number; reason: string }>;
}

/**
 * 公告/财报来源类型是 API 边界稳定枚举，避免 UI 和 ingestion package 重复声明。
 */
export type FilingSourceKindDto = "local_file" | "remote_url" | "mock_text";

/**
 * 文件来源 DTO 只保存跨边界需要展示和追踪的信息，不包含解析器内部状态。
 */
export interface FilingSourceDto {
  kind: FilingSourceKindDto;
  uri: string;
  provider?: string;
}

/**
 * 公告/财报类型用于后续筛选和检索，不绑定任何数据库模型。
 */
export type FilingReportTypeDto =
  | "annual_report"
  | "quarterly_report"
  | "interim_report"
  | "announcement"
  | "unknown";

/**
 * 公告/财报文档 DTO 表达 ingestion 输出的原始文本和元数据边界。
 */
export interface FilingDocumentDto {
  id: string;
  title: string;
  ticker?: string;
  reportType: FilingReportTypeDto;
  publishedAt?: ISODateTimeString;
  source: FilingSourceDto;
  metadata: Record<string, string | number | boolean | null>;
  rawText: string;
}

/**
 * Ingestion 支持的文件类型保持为小枚举，避免 API/UI 对扩展名做重复判断。
 */
export type FilingFileTypeDto = "pdf" | "markdown" | "txt";

/**
 * Ingestion 文本块 DTO 保存原文位置线索，是后续 chunk 和 citation 的证据来源。
 */
export interface IngestedTextBlockDto {
  id: string;
  text: string;
  heading?: string;
  lineStart: number;
  lineEnd: number;
  pageNumber?: number;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * Ingestion 输出 DTO 表达解析后的文档、文件来源和 block 级原文边界。
 */
export interface IngestedFilingDocumentDto {
  documentId: string;
  source: string;
  fileName: string;
  title: string;
  fileType: FilingFileTypeDto;
  createdAt: ISODateTimeString;
  metadata: Record<string, string | number | boolean | null>;
  blocks: IngestedTextBlockDto[];
}

/**
 * RAG 文档 DTO 表达可检索文档的稳定身份和来源，不包含全文。
 */
export interface RagDocumentDto {
  id: string;
  title: string;
  sourceUri: string;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * RAG chunk DTO 表达切分后的文本片段和来源位置，用于检索、引用和评测。
 */
export interface RagChunkDto {
  chunkId: string;
  id: string;
  documentId: string;
  source: string;
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  startOffset: number;
  endOffset: number;
  page?: number;
  pageNumber?: number;
  heading?: string;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * Embedded chunk DTO 在 chunk 基础上增加向量和 embedding 模型信息，作为检索索引的跨边界数据形态。
 */
export interface EmbeddedChunkDto extends RagChunkDto {
  embedding: readonly number[];
  embeddingModel: string;
}

/**
 * Embedding usage DTO 记录本次 mock 或真实 provider 调用的输入规模，后续可扩展为 token 成本统计。
 */
export interface EmbeddingUsageDto {
  inputTexts: number;
  inputCharacters: number;
}

/**
 * 向量检索命中 DTO 保存完整 chunk、相似度分数和排序，便于 API/UI 展示证据。
 */
export interface VectorSearchMatchDto {
  chunk: EmbeddedChunkDto;
  score: number;
  rank: number;
}

/**
 * 检索 score breakdown DTO 暴露向量、关键词、rerank 与最终分数，便于 UI 和 trace 解释排序原因。
 */
export interface RetrievalScoreBreakdownDto {
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
  rerankScore?: number;
  finalScore: number;
  vectorWeight: number;
  keywordWeight: number;
  matchedTerms: string[];
  queryTermCoverage: number;
  headingMatch: boolean;
}

/**
 * 引用 DTO 连接回答片段和原始 chunk，是 grounded answer 的最小证据结构。
 */
export interface CitationDto {
  chunkId: string;
  documentId: string;
  source: string;
  heading?: string;
  chunkIndex: number;
  quote: string;
  pageNumber?: number;
  confidence: number;
}

/**
 * 检索结果 DTO 保存 chunk 文本、分数和可直接展示的引用信息。
 */
export interface RetrievalResultDto {
  chunkId: string;
  documentId: string;
  score: number;
  rank?: number;
  text: string;
  scoreBreakdown?: RetrievalScoreBreakdownDto;
  citation: CitationDto;
}

/**
 * RAG answer DTO 是 API 返回给 UI 的 grounded answer 合同。
 */
export interface RagAnswerDto {
  answer: string;
  citations: CitationDto[];
  retrievalResults: RetrievalResultDto[];
}

/**
 * Data Sources ingestion 请求 DTO，API adapter 负责校验后交给 RAG runtime。
 */
export interface DataSourceIngestRequestDto {
  source: string;
  fileName: string;
  contentType?: string;
  content: string;
}

/**
 * RAG 文档可见范围 DTO：private 仅 owner 可见，shared/demo 对所有调用方可见。
 */
export type RagDocumentScopeDto = "private" | "shared" | "demo";

/**
 * RAG 文档版本状态 DTO：failed 为终态但允许同内容重试。
 */
export type RagDocumentVersionStatusDto = "pending" | "indexed" | "failed";

/**
 * Data Sources 文档摘要 DTO，表达持久化文档身份、最新版本状态和来源，不包含全文。
 */
export interface DataSourceDocumentDto {
  documentId: string;
  title: string;
  scope: RagDocumentScopeDto;
  sourceType: FilingSourceKindDto;
  externalId: string;
  sourceUri: string;
  latestVersion: number;
  latestStatus: RagDocumentVersionStatusDto;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

/**
 * Data Sources ingestion 响应 DTO，展示文档、版本号、幂等命中标记和本次入库 chunk 数量。
 */
export interface DataSourceIngestResponseDto {
  document: IngestedFilingDocumentDto;
  chunks: RagChunkDto[];
  indexedChunkCount: number;
  documentVersion: number;
  deduplicated: boolean;
}

/**
 * Data Sources 文档列表响应 DTO，使用稳定 cursor 分页。
 */
export interface DataSourceDocumentsResponseDto {
  documents: DataSourceDocumentDto[];
  nextCursor: string | null;
}

/**
 * Data Sources chunk 列表响应 DTO，使用稳定 cursor 分页。
 */
export interface DataSourceChunksResponseDto {
  chunks: RagChunkDto[];
  nextCursor: string | null;
}

/**
 * RAG search 请求 DTO。
 */
export interface RagSearchRequestDto {
  query: string;
  topK?: number;
}

/**
 * RAG search 响应 DTO，包含可展示结果和脱敏检索 trace。
 */
export interface RagSearchResponseDto {
  results: RetrievalResultDto[];
  trace: TraceRetrievalEventDto;
}

/**
 * RAG answer 请求 DTO。
 */
export interface RagAnswerRequestDto {
  question: string;
  topK?: number;
}

/**
 * RAG answer 响应 DTO，answer 内含 citations，trace 用于解释召回。
 */
export interface RagAnswerResponseDto {
  answer: RagAnswerDto;
  trace: TraceRetrievalEventDto;
}

/**
 * Eval case DTO 描述单条 RAG 回归评测输入和期望约束。
 *
 * 扩展字段说明：
 * - `expectedAnswer`：人工撰写的期望回答要点，用于可解释 correctness 检查。
 * - `expectedKeywords`：答案中期望出现的关键词集合；deterministic correctness 可基于关键词覆盖度打分。
 * - `requiredDocumentIds`：期望被召回的文档 id 列表，用于计算 retrieval hit rate。
 * - `requiredSources`：期望被召回的文档 source 列表，作为 documentId 不稳定时的替代命中条件。
 * - `expectedChunkIds`：可选，期望进入 topK 的具体 chunk id，用于更严格的 chunk-level 命中检查。
 * - `minCitations`：答案中至少需要的引用数量，用于 citation coverage 指标。
 * - `tags`：用于按主题、难度或文档来源分组统计。
 */
export interface EvalCaseDto {
  id: string;
  question: string;
  expectedAnswer?: string;
  expectedKeywords?: string[];
  requiredDocumentIds?: string[];
  requiredSources?: string[];
  expectedChunkIds?: string[];
  minCitations?: number;
  tags?: string[];
}

/**
 * Eval metric DTO 表达单项评测指标，便于后续报告和 CI 回归消费。
 */
export interface EvalMetricDto {
  name: string;
  score: number;
  passed: boolean;
  details?: string;
}

/**
 * Eval result DTO 聚合模型回答和指标结果，是 eval 报告的跨边界输出。
 */
export interface EvalResultDto {
  caseId: string;
  question: string;
  answer: RagAnswerDto;
  expectedAnswer?: string;
  metrics: EvalMetricDto[];
  passed: boolean;
}

/**
 * RAG 评测总体指标 DTO，用于报告和 CI 回归阈值判断。
 */
export interface RagEvalMetricsDto {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  retrievalHitRate: number;
  answerCorrectness: number;
  faithfulness: number;
  citationCoverage: number;
}

/**
 * 单条失败案例记录 DTO，便于回溯 query、召回、答案和引用。
 */
export interface RagEvalFailureDto {
  caseId: string;
  question: string;
  answerText: string;
  expectedAnswer?: string;
  retrievedChunkIds: string[];
  citationChunkIds: string[];
  failedMetrics: EvalMetricDto[];
  analysis: string;
}

/**
 * RAG 评测报告 DTO，包含总体指标、逐条结果、失败案例和优化建议。
 */
export interface RagEvalReportDto {
  metrics: RagEvalMetricsDto;
  results: EvalResultDto[];
  failures: RagEvalFailureDto[];
  recommendations: string[];
}

export * from "./llm.js";
