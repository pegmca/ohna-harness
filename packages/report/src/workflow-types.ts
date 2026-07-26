import type { DataSourceRuntime } from "@aiagent/rag";
import type { TraceRecorder } from "@aiagent/trace";
import type {
  ReportPlanDto,
  ToolApprovalDecisionDto,
  WorkflowErrorDto,
  WorkflowRunDto
} from "@aiagent/types";
import type { WorkflowState } from "@aiagent/workflow";
import type {
  ReportAnalyzerOutput,
  ReportCitationVerifierOutput,
  ReportDataCollectorOutput,
  ReportPdfExporterOutput,
  ReportRiskCheckerOutput,
  ReportWriterOutput
} from "./schemas.js";

export interface ReportWorkflowDemoDocument {
  source: string;
  fileName: string;
  contentType?: string;
  content: string;
}

export interface ReportWorkflowState extends WorkflowState {
  plan: ReportPlanDto;
  documents: ReportWorkflowDemoDocument[];
  dataSourceRuntime?: DataSourceRuntime;
  followUpQueries?: string[];
  verifierRetryCount?: number;
  collectedData?: ReportDataCollectorOutput;
  analysis?: ReportAnalyzerOutput;
  risks?: ReportRiskCheckerOutput;
  citations?: ReportCitationVerifierOutput;
  draft?: ReportWriterOutput;
  export?: ReportPdfExporterOutput;
}

export interface RunReportWorkflowOptions {
  runId?: string;
  maxSteps?: number;
  maxRetries?: number;
  trace?: TraceRecorder;
  documents?: ReportWorkflowDemoDocument[];
  approvalDecisions?: ToolApprovalDecisionDto[];
  deadlineMs?: number;
  signal?: AbortSignal;
  dataSourceRuntime?: DataSourceRuntime;
}

export interface ReportWorkflowResultOk {
  ok: true;
  run: WorkflowRunDto;
  state: ReportWorkflowState;
  draft: ReportWriterOutput;
  export: ReportPdfExporterOutput;
}

export interface ReportWorkflowResultError {
  ok: false;
  run: WorkflowRunDto;
  state: ReportWorkflowState;
  error: WorkflowErrorDto;
  approvalRequest?: WorkflowRunDto["approvalRequest"];
}

export type ReportWorkflowResult = ReportWorkflowResultOk | ReportWorkflowResultError;

export interface ReportPackageSummary {
  packageName: "@aiagent/report";
  boundary: "report_workflow_nodes_writer_export_adapter";
  runtimeState: "agentic_rag_ready";
}

export interface ResearchReportPdfInput {
  title: string;
  generatedAt: string;
  markdown: string;
  citations: Array<{ id: string; source: string; quote: string }>;
}
