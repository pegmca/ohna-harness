import type { WorkflowEventSink, WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportPdfExporterInputSchema,
  reportPdfExporterOutputSchema,
  type ReportPdfExporterInput,
  type ReportPdfExporterOutput
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * PDF Exporter 占位节点，不生成真实 PDF，只返回后续导出适配器需要的结构。
 * approval 门删除后导出不再暂停：真实 PDF 由 report 工具层在 workflow 结束后直接发布。
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
    execute: async (input, context) => {
      const fileName = `${input.draft.title.replace(/\s+/g, "_")}.pdf`;
      await emitPdfExportEvent(context.sink, context.runId, "not_implemented", input.draft.title, fileName);
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

/**
 * 经 sink 发出 pdf_export 占位事件（payload 与原 trace 事件本体同形状），不保存报告正文。
 *
 * @param sink 节点事件出口。
 * @param workflowRunId workflow run id。
 * @param status 导出边界状态；真实 ready/failed 由 report 工具层在发布后发出。
 * @param title 报告标题。
 * @param fileName 导出文件名。
 * @returns sink 完成 Promise。
 */
async function emitPdfExportEvent(
  sink: WorkflowEventSink | undefined,
  workflowRunId: string,
  status: "not_implemented",
  title?: string,
  fileName?: string
): Promise<void> {
  if (!sink) return;
  try {
    await sink({
      type: "pdf_export",
      payload: {
        workflowRunId,
        status,
        fileName: fileName ?? (title ? `${title.replace(/\s+/g, "_")}.pdf` : undefined),
        durationMs: 0,
        createdAt: new Date().toISOString()
      }
    });
  } catch {
    // sink 是旁路观测能力，不能改变导出结果。
  }
}
