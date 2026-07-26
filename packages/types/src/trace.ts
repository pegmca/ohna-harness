import type { ApiError } from "./api.js";
import type { ISODateTimeString } from "./primitives.js";
import type { ReportPlanDto, ReportPlannerInputDto, ReportTriggerSourceDto } from "./report.js";
import type { WorkflowErrorDto, WorkflowNodeStatusDto } from "./workflow.js";

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
