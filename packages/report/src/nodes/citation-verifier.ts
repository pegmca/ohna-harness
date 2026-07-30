import type { TraceRecorder } from "@aiagent/trace";
import type { WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportCitationVerifierInputSchema,
  reportCitationVerifierOutputSchema,
  type CitationVerifierDecision,
  type ReportCitationVerifierInput,
  type ReportCitationVerifierOutput
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * Citation Verifier 节点：检查每个关键 claim 是否有 citation 支撑，并判断财务指标是否齐全。
 * 当证据不足且未达 max retries 时，通过 decideNext 触发回到 Data Collector 的补充检索。
 *
 * @param maxRetries 最大补充检索次数。
 * @returns workflow node definition。
 */
export function createCitationVerifierNode(maxRetries: number): WorkflowNodeDefinition<
  ReportCitationVerifierInput,
  ReportCitationVerifierOutput,
  ReportWorkflowState
> {
  return {
    nodeId: "citation_verifier",
    type: "report.citation_verifier",
    title: "Citation Verifier",
    inputSchema: reportCitationVerifierInputSchema,
    outputSchema: reportCitationVerifierOutputSchema,
    buildInput: (state) => ({
      analysis: state.analysis,
      collectedData: state.collectedData,
      risks: state.risks
    }),
    execute: (input, context) => {
      const evidenceById = new Map(input.collectedData.evidence.map((item) => [item.id, item]));
      const citationsById = new Map<string, ReportCitationVerifierOutput["citations"][number]>();
      const missingClaims: string[] = [];
      const missingMetrics: string[] = [];
      const missingCitationFindings: string[] = [];

      for (const claim of input.analysis.claims) {
        const hasEvidence = claim.evidenceIds.some((id) => evidenceById.has(id));
        const hasCitation = claim.citationIds.length > 0;

        if (hasEvidence && hasCitation) {
          for (const evidenceId of claim.evidenceIds) {
            const evidence = evidenceById.get(evidenceId);
            if (evidence && !citationsById.has(evidence.id)) {
              citationsById.set(evidence.id, {
                id: evidence.id,
                source: evidence.source,
                quote: evidence.quote,
                supportsFinding: claim.text,
                claimId: claim.id,
                documentId: evidence.citation?.documentId,
                chunkId: evidence.citation?.chunkId,
                chunkIndex: evidence.citation?.chunkIndex,
                heading: evidence.citation?.heading
              });
            }
          }
        } else {
          missingClaims.push(claim.text);
          missingCitationFindings.push(claim.text);
        }
      }

      for (const metric of input.analysis.metricRequirements) {
        if (metric.required && !metric.found) {
          missingMetrics.push(metric.name);
        }
      }

      const followUpQueries = buildFollowUpQueries(
        input.collectedData.subject,
        missingClaims,
        missingMetrics,
        input.risks.followUpQueries
      );

      const retryCount = context.state.verifierRetryCount ?? 0;
      const hasGap = missingClaims.length > 0 || missingMetrics.length > 0;
      const canRetry = retryCount < maxRetries;

      let decision: CitationVerifierDecision;
      if (!hasGap) {
        decision = "pass";
      } else if (missingMetrics.length > 0 && missingClaims.length === 0) {
        decision = canRetry ? "needs_metric" : "fail";
      } else {
        decision = canRetry ? "needs_more_evidence" : "fail";
      }

      recordVerifierDecisionTrace(context.trace, context.runId, decision, missingClaims, missingMetrics, followUpQueries, retryCount, maxRetries);

      return {
        decision,
        verified: decision === "pass",
        citations: [...citationsById.values()],
        missingCitationFindings,
        missingClaims,
        missingMetrics,
        followUpQueries,
        retryCount,
        maxRetries
      };
    },
    decideNext: (output) => {
      if (
        (output.decision === "needs_more_evidence" || output.decision === "needs_metric" || output.decision === "retry_tool") &&
        output.retryCount < output.maxRetries
      ) {
        return "data_collector";
      }
      return undefined;
    },
    applyOutput: (state, output) => ({
      ...state,
      citations: output,
      followUpQueries: output.followUpQueries,
      verifierRetryCount: output.retryCount + 1
    }),
    summarizeInput: (input) => ({
      claimCount: input.analysis.claims.length,
      evidenceCount: input.collectedData.evidence.length,
      riskLevel: input.risks.riskLevel
    }),
    summarizeOutput: (output) => ({
      decision: output.decision,
      verified: output.verified,
      citationCount: output.citations.length,
      missingClaimCount: output.missingClaims.length,
      missingMetricCount: output.missingMetrics.length,
      followUpQueryCount: output.followUpQueries.length,
      retryCount: output.retryCount,
      maxRetries: output.maxRetries
    })
  };
}

/**
 * 根据缺失的 claims、metrics 和 Risk Checker 建议生成 follow-up queries。
 * 这是第一版启发式 query 生成：直接拼接研究对象和缺失关键词，不做复杂 query rewriting。
 *
 * @param subject 研究对象。
 * @param missingClaims 缺失引用的 claims。
 * @param missingMetrics 缺失的财务指标。
 * @param riskFollowUpQueries Risk Checker 建议的补充检索。
 * @returns follow-up query 列表。
 */
function buildFollowUpQueries(
  subject: string,
  missingClaims: readonly string[],
  missingMetrics: readonly string[],
  riskFollowUpQueries: readonly string[]
): string[] {
  const queries: string[] = [];

  for (const claim of missingClaims.slice(0, 2)) {
    const keyword = claim.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ").trim().split(/\s+/).slice(0, 4).join(" ");
    if (keyword.length > 0) {
      queries.push(`${subject} ${keyword}`);
    }
  }

  for (const metric of missingMetrics) {
    queries.push(`${subject} ${metric}`);
  }

  queries.push(...riskFollowUpQueries);

  return [...new Set(queries)];
}

/**
 * 记录 Citation Verifier 的决策到 trace，满足 Agentic RAG 可解释性要求。
 *
 * @param trace trace recorder。
 * @param decision verifier 决策。
 * @param missingClaims 缺失引用的 claims。
 * @param missingMetrics 缺失的财务指标。
 * @param followUpQueries 生成的补充检索 queries。
 * @param retryCount 当前 retry 次数。
 * @param _maxRetries 最大 retry 次数（保留参数位，暂不进 trace 负载）。
 */
function recordVerifierDecisionTrace(
  trace: TraceRecorder | undefined,
  workflowRunId: string,
  decision: CitationVerifierDecision,
  missingClaims: readonly string[],
  missingMetrics: readonly string[],
  followUpQueries: readonly string[],
  retryCount: number,
  _maxRetries: number
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "citation_verifier",
      id: `agent_step_verifier_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      workflowRunId,
      decision,
      retryCount,
      missingClaimCount: missingClaims.length,
      missingMetricCount: missingMetrics.length,
      durationMs: 0,
      ok: decision !== "fail",
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 失败不应影响 workflow 主流程。
  }
}
