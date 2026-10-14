import type { DataSourceRuntime } from "@aiagent/rag";
import type {
  ReportPlanDto,
  WorkflowErrorDto,
  WorkflowRunDto
} from "@aiagent/types";
import type { WorkflowEventSink, WorkflowState } from "@aiagent/workflow";
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
  /** 由调用方显式注入的 RAG runtime：workflow 内部不自建，避免引入静默不可用的缺省 runtime。 */
  dataSourceRuntime: DataSourceRuntime;
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
  /** 节点观测事件出口（workflow_node / pdf_export / citation_verifier 等），payload 与原 trace 事件本体同形状。 */
  sink?: WorkflowEventSink;
  documents?: ReportWorkflowDemoDocument[];
  deadlineMs?: number;
  signal?: AbortSignal;
  /** 必填 RAG runtime：生产由组合根注入真实 runtime，测试显式注入 testing.ts 替身。 */
  dataSourceRuntime: DataSourceRuntime;
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
