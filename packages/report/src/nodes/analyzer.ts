import type { WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportAnalyzerInputSchema,
  reportAnalyzerOutputSchema,
  type ReportAnalyzerInput,
  type ReportAnalyzerOutput,
  type ReportClaim,
  type ReportDataCollectorOutput,
  type ReportMetricRequirement
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * Analyzer 节点：从收集到的证据生成结构化分析，包括 thesis、findings、claims 和 metric requirements。
 * 每个 claim 都显式记录 evidenceIds 和 citationIds，为 Citation Verifier 提供可校验单元。
 *
 * @returns workflow node definition。
 */
export function createAnalyzerNode(): WorkflowNodeDefinition<ReportAnalyzerInput, ReportAnalyzerOutput, ReportWorkflowState> {
  return {
    nodeId: "analyzer",
    type: "report.analyzer",
    title: "Analyzer",
    inputSchema: reportAnalyzerInputSchema,
    outputSchema: reportAnalyzerOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      collectedData: state.collectedData
    }),
    execute: (input) => {
      const subject = input.collectedData.subject;
      const timeRange = input.collectedData.timeRange;
      const evidence = input.collectedData.evidence;
      const findings: string[] = [];
      const claims: ReportClaim[] = [];

      if (evidence.length === 0) {
        findings.push(`当前资料中未找到关于 ${subject} 的可用证据。`);
        claims.push({
          id: "claim_no_evidence",
          text: `无法基于现有资料对 ${subject} 形成结论。`,
          evidenceIds: [],
          citationIds: []
        });
      } else {
        findings.push(`${subject} 在 ${timeRange} 找到 ${evidence.length} 条证据。`);
        claims.push({
          id: "claim_evidence_count",
          text: findings[0],
          evidenceIds: evidence.map((item) => item.id),
          citationIds: evidence.map((item) => item.citation?.chunkId).filter((id): id is string => typeof id === "string")
        });

        const topEvidence = evidence[0];
        if (topEvidence) {
          findings.push(`依据 ${topEvidence.source}，${topEvidence.quote}`);
          claims.push({
            id: "claim_top_evidence",
            text: findings[findings.length - 1],
            evidenceIds: [topEvidence.id],
            citationIds: topEvidence.citation ? [topEvidence.citation.chunkId] : []
          });
        }
      }

      const metricRequirements = detectMetricRequirements(input.plan.requiredData, input.collectedData.financialMetrics);

      return {
        thesis: `${subject} ${input.plan.reportType} 初步结论：${
          evidence.length > 0 ? "已找到部分证据，需进一步验证引用充分性。" : "当前资料不足，无法形成可靠判断。"
        }`,
        findings,
        claims,
        metricRequirements,
        evidenceIds: evidence.map((item) => item.id)
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      analysis: output
    }),
    summarizeInput: (input) => ({
      subject: input.collectedData.subject,
      reportType: input.plan.reportType,
      evidenceCount: input.collectedData.evidence.length
    }),
    summarizeOutput: (output) => ({
      findingCount: output.findings.length,
      claimCount: output.claims.length,
      evidenceIdCount: output.evidenceIds.length
    })
  };
}

/**
 * 根据 plan 要求的财务指标和已抽取的指标，生成结构化 metric requirements。
 * 第一版只覆盖净利润、ROE、营业收入三类常见指标。
 *
 * @param requiredData plan 要求的数据类型。
 * @param financialMetrics 已抽取的财务指标。
 * @returns metric requirement 列表。
 */
function detectMetricRequirements(
  requiredData: readonly string[],
  financialMetrics: readonly ReportDataCollectorOutput["financialMetrics"][number][]
): ReportMetricRequirement[] {
  if (!requiredData.includes("financial_metrics")) {
    return [];
  }

  const foundMetrics = new Set(financialMetrics.map((metric) => metric.name));

  return [
    { name: "net_profit", required: true, found: foundMetrics.has("net_profit") },
    { name: "roe", required: true, found: foundMetrics.has("roe") },
    { name: "revenue", required: false, found: foundMetrics.has("revenue") }
  ];
}
