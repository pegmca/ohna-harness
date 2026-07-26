import type { ApiError } from "./api.js";
import type { ISODateTimeString } from "./primitives.js";
import type { WorkflowRunDto } from "./workflow.js";

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
