import type { WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportRiskCheckerInputSchema,
  reportRiskCheckerOutputSchema,
  type ReportRiskCheckerInput,
  type ReportRiskCheckerOutput
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * Risk Checker 节点：判断风险披露是否不足。
 * 当 reportType 为 risk_review 且未找到风险相关证据时，输出 needsMoreEvidence 和 follow-up queries。
 *
 * @returns workflow node definition。
 */
export function createRiskCheckerNode(): WorkflowNodeDefinition<ReportRiskCheckerInput, ReportRiskCheckerOutput, ReportWorkflowState> {
  return {
    nodeId: "risk_checker",
    type: "report.risk_checker",
    title: "Risk Checker",
    inputSchema: reportRiskCheckerInputSchema,
    outputSchema: reportRiskCheckerOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      analysis: state.analysis,
      collectedData: state.collectedData
    }),
    execute: (input) => {
      const riskEvidence = input.collectedData.evidence.filter((item) =>
        /风险|不良|拨备|逾期|关注类|房地产|下行|承压|减值|敞口/.test(item.quote)
      );
      const hasRiskDisclosure = riskEvidence.length > 0;
      const riskItems: string[] = [
        "当前为学习阶段 demo 数据路径，不能作为投资建议。",
        "Citation Verifier 会对关键结论进行二次检索校验。"
      ];
      let needsMoreEvidence = false;
      let followUpQueries: string[] = [];

      if (!hasRiskDisclosure && input.plan.reportType === "risk_review") {
        needsMoreEvidence = true;
        riskItems.push(`未找到 ${input.collectedData.subject} 的风险披露证据，Risk Checker 建议补充检索。`);
        followUpQueries = [
          `${input.collectedData.subject} 风险因素`,
          `${input.collectedData.subject} 不良贷款 风险`,
          `${input.collectedData.subject} 房地产行业风险`
        ];
      } else if (hasRiskDisclosure) {
        riskItems.push(`已识别 ${riskEvidence.length} 条风险相关证据。`);
      }

      return {
        riskLevel: hasRiskDisclosure ? "medium" : "low",
        riskItems,
        passed: true,
        needsMoreEvidence,
        followUpQueries
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      risks: output
    }),
    summarizeOutput: (output) => ({
      riskLevel: output.riskLevel,
      riskCount: output.riskItems.length,
      passed: output.passed,
      needsMoreEvidence: output.needsMoreEvidence,
      followUpQueryCount: output.followUpQueries.length
    })
  };
}
