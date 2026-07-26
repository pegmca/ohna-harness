import type { AnyWorkflowNodeDefinition } from "@aiagent/workflow";
import type { ReportWorkflowState } from "../workflow-types.js";
import { createDataCollectorNode } from "./data-collector.js";
import { createAnalyzerNode } from "./analyzer.js";
import { createRiskCheckerNode } from "./risk-checker.js";
import { createCitationVerifierNode } from "./citation-verifier.js";
import { createReportWriterNode } from "./writer.js";
import { createPdfExporterNode } from "./pdf-exporter.js";

/** Citation Verifier 默认最大补充检索次数（内部常量，不作为包公共 API 导出）。 */
const DEFAULT_MAX_RETRIES = 2;

/**
 * 创建 Report Workflow 节点定义，Citation Verifier 通过 decideNext 实现补充检索循环。
 *
 * @param maxRetries Citation Verifier 最大补充检索次数。
 * @returns 顺序节点定义（含隐式循环回边）。
 */
export function createReportWorkflowNodes(maxRetries: number = DEFAULT_MAX_RETRIES): AnyWorkflowNodeDefinition<ReportWorkflowState>[] {
  return [
    createDataCollectorNode(maxRetries),
    createAnalyzerNode(),
    createRiskCheckerNode(),
    createCitationVerifierNode(maxRetries),
    createReportWriterNode(),
    createPdfExporterNode()
  ];
}
