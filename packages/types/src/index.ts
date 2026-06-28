export type ISODateTimeString = string;

export type RequestId = string;

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
  details?: Record<string, unknown>;
}

export interface TraceDto {
  traceId: string;
  requestId: string;
  startedAt: ISODateTimeString;
  events: TraceEventDto[];
}

export type TraceEventDto =
  | TraceRequestReceivedEventDto
  | TraceIntentRoutedEventDto
  | TraceAgentStepEventDto
  | TraceModelCallEventDto
  | TraceToolCallEventDto
  | TraceFinalResponseEventDto;

export interface TraceEventBaseDto {
  type: string;
  id: string;
  traceId: string;
  requestId: string;
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

export interface TraceModelCallEventDto extends TraceEventBaseDto {
  type: "model_call";
  model: string;
  purpose: string;
  durationMs: number;
  ok: boolean;
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
  error?: TraceErrorDto;
}

export interface TraceFinalResponseEventDto extends TraceEventBaseDto {
  type: "final_response";
  answerPreview: string;
  ok: boolean;
  error?: TraceErrorDto;
}

export interface AgentRunRequestDto {
  message: string;
  reportMode?: boolean;
  conversationId?: string;
}

export interface AgentRunResponseDto {
  conversationId: string;
  requestId: string;
  traceId: string;
  ok: boolean;
  intent: AgentIntentDto;
  answer: string;
  steps: AgentStepDto[];
  trace: TraceDto;
  error?: ApiError;
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
  id: string;
  documentId: string;
  text: string;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * 引用 DTO 连接回答片段和原始 chunk，是 grounded answer 的最小证据结构。
 */
export interface CitationDto {
  chunkId: string;
  documentId: string;
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
  text: string;
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
 * Eval case DTO 描述单条 RAG 回归评测输入和期望约束。
 */
export interface EvalCaseDto {
  id: string;
  question: string;
  expectedAnswer?: string;
  requiredDocumentIds?: string[];
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

export * from "./llm.js";
