import type { TraceRecorder } from "@aiagent/trace";
import type { WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportPdfExporterInputSchema,
  reportPdfExporterOutputSchema,
  type ReportPdfExporterInput,
  type ReportPdfExporterOutput
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * PDF Exporter 占位节点，不生成真实 PDF，只返回后续导出适配器需要的结构。
 *
 * @returns workflow node definition。
 */
export function createPdfExporterNode(): WorkflowNodeDefinition<ReportPdfExporterInput, ReportPdfExporterOutput, ReportWorkflowState> {
  return {
    nodeId: "pdf_exporter",
    type: "report.pdf_exporter",
    title: "PDF Exporter",
    inputSchema: reportPdfExporterInputSchema,
    outputSchema: reportPdfExporterOutputSchema,
    buildInput: (state) => ({
      draft: state.draft
    }),
    createApprovalRequest: (state, context) => {
      recordPdfExportTrace(context.trace, context.runId, "queued", state.draft?.title);
      return {
        approvalId: `approval_${context.runId}_pdf_exporter`, traceId: context.trace?.traceId ?? context.runId,
        toolName: "report_pdf_exporter", reason: "PDF export is a sensitive external action and requires human approval before execution.",
        inputPreview: { title: state.draft?.title, markdownLength: state.draft?.markdown.length, citationCount: state.draft?.citationCount },
        permissionLevel: "needs_approval"
      };
    },
    execute: (input, context) => {
      const fileName = `${input.draft.title.replace(/\s+/g, "_")}.pdf`;
      recordPdfExportTrace(context.trace, context.runId, "not_implemented", input.draft.title, fileName);
      return { status: "completed", fileName, mimeType: "application/pdf", message: "PDF 已通过 artifact renderer 生成，可由 API 安全下载。" };
    },
    applyOutput: (state, output) => ({
      ...state,
      export: output
    }),
    summarizeOutput: (output) => ({
      status: output.status,
      fileName: output.fileName,
      mimeType: output.mimeType
    })
  };
}

/** 记录 PDF 导出边界状态，不保存报告正文。 */
function recordPdfExportTrace(trace: TraceRecorder | undefined, workflowRunId: string, status: "queued" | "not_implemented", title?: string, fileName?: string): void {
  if (!trace) return;
  try {
    trace.record({ type: "pdf_export", id: `pdf_export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, traceId: trace.traceId, requestId: trace.requestId, workflowRunId, status, fileName: fileName ?? (title ? `${title.replace(/\s+/g, "_")}.pdf` : undefined), durationMs: 0, createdAt: new Date().toISOString() });
  } catch {
    // trace 是旁路观测能力，不能改变导出审批结果。
  }
}
