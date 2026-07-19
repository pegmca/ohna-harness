import { createDataSourceRuntime } from "@aiagent/rag";
import type { Citation, DataSourceRuntime, RetrievalResult } from "@aiagent/rag";
import type { TraceRecorder } from "@aiagent/trace";
import type {
  DataSourceIngestRequestDto,
  ReportPlanDto,
  ToolApprovalDecisionDto,
  WorkflowErrorDto,
  WorkflowRunDto
} from "@aiagent/types";
import {
  runSequentialWorkflow,
  type AnyWorkflowNodeDefinition,
  type WorkflowNodeDefinition,
  type WorkflowState
} from "@aiagent/workflow";
import { z } from "zod";

const reportPlanSchema = z.object({
  planId: z.string(),
  status: z.enum(["ready", "needs_clarification", "partial"]),
  triggerSource: z.enum(["toggle", "button", "natural_language"]),
  reportType: z.enum(["company_brief", "earnings_review", "risk_review", "custom"]),
  subject: z.string().optional(),
  timeRange: z.string().optional(),
  requiredData: z.array(z.string()),
  assumptions: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string(),
      requiredData: z.array(z.string()),
      optional: z.boolean()
    })
  )
});

const citationVerifierDecisionSchema = z.enum(["pass", "needs_more_evidence", "needs_metric", "retry_tool", "fail"]);

const reportEvidenceItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  quote: z.string(),
  retrievalResult: z.any().optional(),
  citation: z.any().optional(),
  query: z.string().optional()
});

const reportMetricRequirementSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  found: z.boolean(),
  sourceEvidenceId: z.string().optional()
});

const reportClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  citationIds: z.array(z.string())
});

export const reportDataCollectorInputSchema = z.object({
  plan: reportPlanSchema,
  followUpQueries: z.array(z.string()).optional()
});

export const reportDataCollectorOutputSchema = z.object({
  subject: z.string(),
  timeRange: z.string(),
  filings: z.array(z.string()),
  financialMetrics: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      period: z.string(),
      sourceEvidenceId: z.string().optional()
    })
  ),
  evidence: z.array(reportEvidenceItemSchema),
  retrievalTraces: z.array(z.any()).optional()
  , partial: z.boolean().default(false)
  , sourceErrors: z.array(z.object({ query: z.string(), code: z.string(), message: z.string() })).default([])
});

export const reportAnalyzerInputSchema = z.object({
  plan: reportPlanSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportAnalyzerOutputSchema = z.object({
  thesis: z.string(),
  findings: z.array(z.string()),
  claims: z.array(reportClaimSchema),
  metricRequirements: z.array(reportMetricRequirementSchema),
  evidenceIds: z.array(z.string())
});

export const reportRiskCheckerInputSchema = z.object({
  plan: reportPlanSchema,
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportRiskCheckerOutputSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high"]),
  riskItems: z.array(z.string()),
  passed: z.boolean(),
  needsMoreEvidence: z.boolean(),
  followUpQueries: z.array(z.string())
});

export const reportCitationVerifierInputSchema = z.object({
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema,
  risks: reportRiskCheckerOutputSchema
});

export const reportCitationVerifierOutputSchema = z.object({
  decision: citationVerifierDecisionSchema,
  verified: z.boolean(),
  citations: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      quote: z.string(),
      supportsFinding: z.string(),
      claimId: z.string().optional(),
      documentId: z.string().optional(),
      chunkId: z.string().optional(),
      chunkIndex: z.number().optional(),
      heading: z.string().optional()
    })
  ),
  missingCitationFindings: z.array(z.string()),
  missingClaims: z.array(z.string()),
  missingMetrics: z.array(z.string()),
  followUpQueries: z.array(z.string()),
  retryCount: z.number(),
  maxRetries: z.number()
});

export const reportWriterInputSchema = z.object({
  plan: reportPlanSchema,
  analysis: reportAnalyzerOutputSchema,
  risks: reportRiskCheckerOutputSchema,
  citations: reportCitationVerifierOutputSchema
});

export const reportWriterOutputSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  html: z.string(),
  sectionCount: z.number().int().nonnegative(),
  citationCount: z.number().int().nonnegative()
});

export const reportPdfExporterInputSchema = z.object({
  draft: reportWriterOutputSchema
});

export const reportPdfExporterOutputSchema = z.object({
  status: z.enum(["placeholder"]),
  fileName: z.string(),
  mimeType: z.literal("application/pdf"),
  message: z.string()
});

export type CitationVerifierDecision = z.infer<typeof citationVerifierDecisionSchema>;
export type ReportEvidenceItem = z.infer<typeof reportEvidenceItemSchema>;
export type ReportMetricRequirement = z.infer<typeof reportMetricRequirementSchema>;
export type ReportClaim = z.infer<typeof reportClaimSchema>;
export type ReportDataCollectorInput = z.infer<typeof reportDataCollectorInputSchema>;
export type ReportDataCollectorOutput = z.infer<typeof reportDataCollectorOutputSchema>;
export type ReportAnalyzerInput = z.infer<typeof reportAnalyzerInputSchema>;
export type ReportAnalyzerOutput = z.infer<typeof reportAnalyzerOutputSchema>;
export type ReportRiskCheckerInput = z.infer<typeof reportRiskCheckerInputSchema>;
export type ReportRiskCheckerOutput = z.infer<typeof reportRiskCheckerOutputSchema>;
export type ReportCitationVerifierInput = z.infer<typeof reportCitationVerifierInputSchema>;
export type ReportCitationVerifierOutput = z.infer<typeof reportCitationVerifierOutputSchema>;
export type ReportWriterInput = z.infer<typeof reportWriterInputSchema>;
export type ReportWriterOutput = z.infer<typeof reportWriterOutputSchema>;
export type ReportPdfExporterInput = z.infer<typeof reportPdfExporterInputSchema>;
export type ReportPdfExporterOutput = z.infer<typeof reportPdfExporterOutputSchema>;

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

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_STEPS = 16;

/**
 * 创建 report package 摘要，说明本阶段已实现带 Critic/Verifier 的 Agentic RAG Workflow。
 *
 * @returns report package 当前能力摘要。
 */
export function createReportPackageSummary(): ReportPackageSummary {
  return {
    packageName: "@aiagent/report",
    boundary: "report_workflow_nodes_writer_export_adapter",
    runtimeState: "agentic_rag_ready"
  };
}

/**
 * 从 Report Planner 输出执行 Agentic RAG Report Workflow：
 * Data Collector 调用 RAG runtime 检索证据，Analyzer 生成带引用的 claims，
 * Risk Checker 检查风险披露，Citation Verifier 判断证据充分性并在不足时触发补充检索，
 * 最后由 Report Writer 生成草稿、PDF Exporter 占位导出。
 *
 * @param plan Report Planner 输出。
 * @param options max steps、max retries、trace、可选 demo documents。
 * @returns 结构化 workflow 结果。
 */
export async function runReportWorkflow(
  plan: ReportPlanDto,
  options: RunReportWorkflowOptions = {}
): Promise<ReportWorkflowResult> {
  const readyError = validateExecutablePlan(plan);
  const initialState: ReportWorkflowState = {
    plan,
    documents: options.documents ?? [],
    dataSourceRuntime: options.dataSourceRuntime ?? createDataSourceRuntime(),
    followUpQueries: [],
    verifierRetryCount: 0
  };

  if (readyError) {
    const now = new Date().toISOString();
    return {
      ok: false,
      state: initialState,
      error: readyError,
      run: {
        runId: options.runId ?? createReportWorkflowRunId(plan.planId),
        workflowName: "report_workflow",
        status: "failed",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        executedSteps: 0,
        nodes: createReportWorkflowNodes(options.maxRetries ?? DEFAULT_MAX_RETRIES).map((node) => ({
          nodeId: node.nodeId,
          type: node.type,
          title: node.title,
          status: "pending",
          durationMs: 0
        })),
        edges: createReportWorkflowEdges(),
        events: [
          {
            id: `report_workflow_event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            type: "workflow_failed",
            createdAt: now,
            error: readyError
          }
        ],
        error: readyError
      }
    };
  }

  const result = await runSequentialWorkflow<ReportWorkflowState>({
    workflowName: "report_workflow",
    runId: options.runId ?? createReportWorkflowRunId(plan.planId),
    initialState,
    nodes: createReportWorkflowNodes(options.maxRetries ?? DEFAULT_MAX_RETRIES),
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    trace: options.trace,
    approvalDecisions: options.approvalDecisions
    , deadlineMs: options.deadlineMs
    , signal: options.signal
  });

  if (!result.ok) {
    return {
      ok: false,
      run: result.run,
      state: result.state,
      error: result.error,
      approvalRequest: result.approvalRequest
    };
  }

  if (!result.state.draft || !result.state.export) {
    const error: WorkflowErrorDto = {
      code: "node_execution_failed",
      message: "Report workflow completed without draft or export state."
    };
    return {
      ok: false,
      run: {
        ...result.run,
        status: "failed",
        error
      },
      state: result.state,
      error
    };
  }

  return {
    ok: true,
    run: result.state.collectedData?.partial ? { ...result.run, partial: true, recovery: [...(result.run.recovery ?? []), { nodeId: "data_collector", action: "partial", attempts: 1, reason: "One or more non-critical data sources failed." }] } : result.run,
    state: result.state,
    draft: result.state.draft,
    export: result.state.export
  };
}

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

/**
 * 创建固定顺序的 report workflow edges，并补充 Citation Verifier → Data Collector 的循环边。
 *
 * @returns edge DTO。
 */
function createReportWorkflowEdges(): { from: string; to: string }[] {
  const nodes = createReportWorkflowNodes(DEFAULT_MAX_RETRIES);
  const sequentialEdges = nodes.slice(0, -1).map((node, index) => ({
    from: node.nodeId,
    to: nodes[index + 1].nodeId
  }));

  return [
    ...sequentialEdges,
    {
      from: "citation_verifier",
      to: "data_collector"
    }
  ];
}

/**
 * Data Collector 节点：基于 plan 生成 RAG queries，调用现有 RAG search/answer 能力收集证据。
 * 支持 follow-up queries（补充检索），并把 retrieval trace 和 citation 一起写入证据。
 *
 * @param maxRetries 仅用于摘要展示，与节点执行无关。
 * @returns workflow node definition。
 */
function createDataCollectorNode(maxRetries: number): WorkflowNodeDefinition<ReportDataCollectorInput, ReportDataCollectorOutput, ReportWorkflowState> {
  return {
    nodeId: "data_collector",
    type: "report.data_collector",
    title: "Data Collector",
    inputSchema: reportDataCollectorInputSchema,
    outputSchema: reportDataCollectorOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      followUpQueries: state.followUpQueries
    }),
    execute: async (input, context) => {
      const subject = input.plan.subject;

      if (!subject) {
        throw new Error("Report workflow requires plan.subject before collecting data.");
      }

      const runtime = context.state.dataSourceRuntime ?? createDataSourceRuntime();
      const timeRange = input.plan.timeRange ?? "最近两年";

      await ingestReportDocuments(runtime, context.state.documents);

      const queries = buildDataCollectorQueries(subject, timeRange, input.plan.requiredData, input.followUpQueries);

      recordDataCollectorTrace(context.trace, queries, input.followUpQueries);

      const evidence: ReportEvidenceItem[] = [];
      const retrievalTraces: unknown[] = [];
      const sourceErrors: Array<{ query: string; code: string; message: string }> = [];

      for (const query of queries) {
        const searchResult = await runtime.search(query, { topK: 3, mode: "hybrid" });

        if (!searchResult.ok) {
          sourceErrors.push({ query, code: searchResult.error.code, message: searchResult.error.message });
          continue;
        }

        retrievalTraces.push(searchResult.data.trace);

        for (const result of searchResult.data.results) {
          evidence.push(createEvidenceItem(result, query, evidence.length));
        }
      }

      const filings = [...new Set(evidence.map((item) => item.source))];
      const financialMetrics = input.plan.requiredData.includes("financial_metrics")
        ? extractFinancialMetrics(evidence, timeRange)
        : [];

      return {
        subject,
        timeRange,
        filings,
        financialMetrics,
        evidence,
        retrievalTraces,
        partial: sourceErrors.length > 0,
        sourceErrors
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      collectedData: mergeCollectedData(state.collectedData, output),
      dataSourceRuntime: state.dataSourceRuntime
    }),
    summarizeInput: (input) => ({
      planId: input.plan.planId,
      subject: input.plan.subject,
      requiredData: input.plan.requiredData,
      followUpQueryCount: input.followUpQueries?.length ?? 0
    }),
    summarizeOutput: (output) => ({
      subject: output.subject,
      timeRange: output.timeRange,
      filingCount: output.filings.length,
      metricCount: output.financialMetrics.length,
      evidenceCount: output.evidence.length,
      retrievalTraceCount: output.retrievalTraces?.length ?? 0
      , partial: output.partial
      , sourceErrorCount: output.sourceErrors.length
    })
  };
}

/**
 * Analyzer 节点：从收集到的证据生成结构化分析，包括 thesis、findings、claims 和 metric requirements。
 * 每个 claim 都显式记录 evidenceIds 和 citationIds，为 Citation Verifier 提供可校验单元。
 *
 * @returns workflow node definition。
 */
function createAnalyzerNode(): WorkflowNodeDefinition<ReportAnalyzerInput, ReportAnalyzerOutput, ReportWorkflowState> {
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
 * Risk Checker 节点：判断风险披露是否不足。
 * 当 reportType 为 risk_review 且未找到风险相关证据时，输出 needsMoreEvidence 和 follow-up queries。
 *
 * @returns workflow node definition。
 */
function createRiskCheckerNode(): WorkflowNodeDefinition<ReportRiskCheckerInput, ReportRiskCheckerOutput, ReportWorkflowState> {
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

/**
 * Citation Verifier 节点：检查每个关键 claim 是否有 citation 支撑，并判断财务指标是否齐全。
 * 当证据不足且未达 max retries 时，通过 decideNext 触发回到 Data Collector 的补充检索。
 *
 * @param maxRetries 最大补充检索次数。
 * @returns workflow node definition。
 */
function createCitationVerifierNode(maxRetries: number): WorkflowNodeDefinition<
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
 * Report Writer 节点：生成 Markdown/HTML 草稿。
 * 当 Citation Verifier 判定证据不足时，必须保留“不足以判断”表达，不编造结论。
 *
 * @returns workflow node definition。
 */
function createReportWriterNode(): WorkflowNodeDefinition<ReportWriterInput, ReportWriterOutput, ReportWorkflowState> {
  return {
    nodeId: "report_writer",
    type: "report.writer",
    title: "Report Writer",
    inputSchema: reportWriterInputSchema,
    outputSchema: reportWriterOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      analysis: state.analysis,
      risks: state.risks,
      citations: state.citations
    }),
    execute: (input) => {
      const subject = input.plan.subject ?? "待确认研究对象";
      const title = `${subject} ${formatReportType(input.plan.reportType)}`;
      const citationLines = input.citations.citations.map(
        (citation, index) => `[^${index + 1}]: ${citation.source} - ${citation.quote}`
      );
      const insufficientEvidence = input.citations.decision === "fail" || input.citations.missingClaims.length > 0;
      const lines: string[] = [
        `# ${title}`,
        "",
        "## 核心结论",
        input.analysis.thesis
      ];

      if (insufficientEvidence) {
        lines.push(
          "",
          "> 资料不足说明：当前检索未能为以下关键结论找到足够引用支撑，报告保留“不足以判断”的表达，不编造结论。"
        );
        lines.push(...input.citations.missingClaims.map((claim) => `- ${claim}`));

        if (input.citations.missingMetrics.length > 0) {
          lines.push("", "## 缺失财务指标", ...input.citations.missingMetrics.map((metric) => `- ${metric}`));
        }
      }

      lines.push(
        "",
        "## 关键发现",
        ...input.analysis.findings.map((finding, index) =>
          `- ${finding}${citationLines.length > 0 ? ` [^${Math.min(index + 1, citationLines.length)}]` : ""}`
        ),
        "",
        "## 风险提示",
        ...input.risks.riskItems.map((risk) => `- ${risk}`),
        "",
        "## 引用",
        ...citationLines
      );

      const markdown = lines.join("\n");

      return {
        title,
        markdown,
        html: markdownToMinimalHtml(markdown),
        sectionCount: insufficientEvidence ? 5 : 4,
        citationCount: input.citations.citations.length
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      draft: output
    }),
    summarizeOutput: (output) => ({
      title: output.title,
      sectionCount: output.sectionCount,
      citationCount: output.citationCount,
      markdownLength: output.markdown.length
    })
  };
}

/**
 * PDF Exporter 占位节点，不生成真实 PDF，只返回后续导出适配器需要的结构。
 *
 * @returns workflow node definition。
 */
function createPdfExporterNode(): WorkflowNodeDefinition<ReportPdfExporterInput, ReportPdfExporterOutput, ReportWorkflowState> {
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
      return { status: "placeholder", fileName, mimeType: "application/pdf", message: "PDF 导出在后续阶段接入；当前节点只保留导出占位结构。" };
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
 * 校验 plan 是否足以执行 workflow，避免缺少研究对象时进入数据收集节点。
 *
 * @param plan Report Planner 输出。
 * @returns 不可执行时的结构化错误。
 */
function validateExecutablePlan(plan: ReportPlanDto): WorkflowErrorDto | undefined {
  if (!plan.subject) {
    return {
      code: "invalid_workflow",
      message: "Report workflow requires plan.subject. Please clarify the research subject before execution.",
      details: {
        planId: plan.planId,
        status: plan.status,
        clarificationQuestions: plan.clarificationQuestions
      }
    };
  }

  if (plan.status === "needs_clarification") {
    return {
      code: "invalid_workflow",
      message: "Report workflow cannot execute while plan needs clarification.",
      details: {
        planId: plan.planId,
        clarificationQuestions: plan.clarificationQuestions
      }
    };
  }

  return undefined;
}

/**
 * 将 demo documents 批量 ingest 到 RAG runtime，跳过已存在的 source 避免重复索引。
 *
 * @param runtime RAG runtime。
 * @param documents 待 ingest 的 demo 文档。
 */
async function ingestReportDocuments(
  runtime: DataSourceRuntime,
  documents: ReportWorkflowDemoDocument[]
): Promise<void> {
  const existingSources = new Set(runtime.listDocuments().map((document) => document.source));

  for (const document of documents) {
    if (existingSources.has(document.source)) {
      continue;
    }

    const request: DataSourceIngestRequestDto = {
      source: document.source,
      fileName: document.fileName,
      contentType: document.contentType,
      content: document.content
    };
    const result = await runtime.ingest(request);

    if (!result.ok) {
      throw new Error(`ingest demo document failed: ${result.error.message}`);
    }
  }
}

/**
 * 根据 plan 和可选的 follow-up queries 生成 Data Collector 检索 queries。
 * 初始检索基于 subject、timeRange 和 requiredData；补充检索直接使用 Critic/Verifier 提供的 queries。
 *
 * @param subject 研究对象。
 * @param timeRange 时间范围。
 * @param requiredData plan 要求的数据类型。
 * @param followUpQueries 可选的补充检索 queries。
 * @returns 本次要执行的 query 列表。
 */
function buildDataCollectorQueries(
  subject: string,
  timeRange: string,
  requiredData: readonly string[],
  followUpQueries: readonly string[] | undefined
): string[] {
  if (followUpQueries && followUpQueries.length > 0) {
    return [...followUpQueries];
  }

  const queries: string[] = [];

  if (requiredData.includes("filings") || requiredData.length === 0) {
    queries.push(`${subject} ${timeRange} 年报`, `${subject} ${timeRange} 公告`);
  }

  if (requiredData.includes("financial_metrics")) {
    queries.push(`${subject} 净利润 ROE ${timeRange}`, `${subject} 营业收入 ${timeRange}`);
  }

  if (requiredData.includes("risk")) {
    queries.push(`${subject} 风险因素`, `${subject} 不良贷款 风险`);
  }

  if (queries.length === 0) {
    queries.push(`${subject} ${timeRange}`);
  }

  return queries;
}

/**
 * 从 retrieval result 创建标准化的报告证据项，保留 citation 和原始 query 便于追溯。
 *
 * @param result RAG retrieval result。
 * @param query 产生该证据的 query。
 * @param index 证据序号，用于生成唯一 id。
 * @returns 报告证据项。
 */
function createEvidenceItem(result: RetrievalResult, query: string, index: number): ReportEvidenceItem {
  return {
    id: `evidence_${result.chunkId}_${String(index).padStart(3, "0")}`,
    source: result.citation.source,
    quote: result.citation.quote,
    retrievalResult: result,
    citation: result.citation,
    query
  };
}

/**
 * 合并多次 Data Collector 运行的结果，按 chunkId 去重证据，避免补充检索引入重复 citation。
 *
 * @param existing 已有的 collected data。
 * @param latest 最新一次 Data Collector 输出。
 * @returns 合并后的 collected data。
 */
function mergeCollectedData(
  existing: ReportDataCollectorOutput | undefined,
  latest: ReportDataCollectorOutput
): ReportDataCollectorOutput {
  if (!existing) {
    return latest;
  }

  const existingChunkIds = new Set(
    existing.evidence.map((item) => item.retrievalResult?.chunkId).filter((id): id is string => typeof id === "string")
  );
  const newEvidence = latest.evidence.filter(
    (item) => typeof item.retrievalResult?.chunkId !== "string" || !existingChunkIds.has(item.retrievalResult.chunkId)
  );

  return {
    subject: latest.subject,
    timeRange: latest.timeRange,
    filings: [...new Set([...existing.filings, ...latest.filings])],
    financialMetrics: deduplicateMetrics([...existing.financialMetrics, ...latest.financialMetrics]),
    evidence: [...existing.evidence, ...newEvidence],
    retrievalTraces: [...(existing.retrievalTraces ?? []), ...(latest.retrievalTraces ?? [])],
    partial: existing.partial || latest.partial,
    sourceErrors: [...existing.sourceErrors, ...latest.sourceErrors]
  };
}

/**
 * 按 name + period 去重财务指标，避免补充检索重复添加同一指标。
 *
 * @param metrics 指标列表。
 * @returns 去重后的指标列表。
 */
function deduplicateMetrics(metrics: ReportDataCollectorOutput["financialMetrics"]): ReportDataCollectorOutput["financialMetrics"] {
  const seen = new Set<string>();

  return metrics.filter((metric) => {
    const key = `${metric.name}_${metric.period}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 从证据文本中抽取常见财务指标，仅作启发式示例，不保证生产级准确性。
 *
 * @param evidence 证据列表。
 * @param period 时间范围，写入指标 period 字段。
 * @returns 抽取到的财务指标列表。
 */
function extractFinancialMetrics(
  evidence: readonly ReportEvidenceItem[],
  period: string
): ReportDataCollectorOutput["financialMetrics"] {
  const metrics: ReportDataCollectorOutput["financialMetrics"] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    const text = item.quote;

    const netProfitMatch = text.match(/净利润[^\d]*(\d+(?:\.\d+)?)\s*亿元/);
    if (netProfitMatch && !seen.has("net_profit")) {
      seen.add("net_profit");
      metrics.push({
        name: "net_profit",
        value: `${netProfitMatch[1]}亿元`,
        period,
        sourceEvidenceId: item.id
      });
    }

    const roeMatch = text.match(/ROE[^\d]*(\d+(?:\.\d+)?)%/);
    if (roeMatch && !seen.has("roe")) {
      seen.add("roe");
      metrics.push({
        name: "roe",
        value: `${roeMatch[1]}%`,
        period,
        sourceEvidenceId: item.id
      });
    }

    const revenueMatch = text.match(/营业收入[^\d]*(\d+(?:\.\d+)?)\s*亿元/);
    if (revenueMatch && !seen.has("revenue")) {
      seen.add("revenue");
      metrics.push({
        name: "revenue",
        value: `${revenueMatch[1]}亿元`,
        period,
        sourceEvidenceId: item.id
      });
    }
  }

  return metrics;
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
 * 记录 Data Collector 的检索意图到 trace，便于观察初始检索和补充检索的 query 差异。
 *
 * @param trace trace recorder。
 * @param queries 本次执行的 queries。
 * @param followUpQueries 可选的 follow-up queries 标记。
 */
function recordDataCollectorTrace(
  trace: TraceRecorder | undefined,
  queries: readonly string[],
  followUpQueries: readonly string[] | undefined
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "tool_call",
      id: `tool_call_data_collector_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      toolName: "report.data_collector_search",
      args: {
        queryCount: queries.length,
        queries: queries.map((query) => (query.length > 60 ? `${query.slice(0, 60)}...` : query)),
        isFollowUp: (followUpQueries?.length ?? 0) > 0
      },
      durationMs: 0,
      ok: true,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 失败不应影响 workflow 主流程。
  }
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
 * @param maxRetries 最大 retry 次数。
 */
function recordVerifierDecisionTrace(
  trace: TraceRecorder | undefined,
  workflowRunId: string,
  decision: CitationVerifierDecision,
  missingClaims: readonly string[],
  missingMetrics: readonly string[],
  followUpQueries: readonly string[],
  retryCount: number,
  maxRetries: number
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

/** 记录 PDF 导出边界状态，不保存报告正文。 */
function recordPdfExportTrace(trace: TraceRecorder | undefined, workflowRunId: string, status: "queued" | "not_implemented", title?: string, fileName?: string): void {
  if (!trace) return;
  try {
    trace.record({ type: "pdf_export", id: `pdf_export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, traceId: trace.traceId, requestId: trace.requestId, workflowRunId, status, fileName: fileName ?? (title ? `${title.replace(/\s+/g, "_")}.pdf` : undefined), durationMs: 0, createdAt: new Date().toISOString() });
  } catch {
    // trace 是旁路观测能力，不能改变导出审批结果。
  }
}

/**
 * 格式化报告类型，供 mock writer 生成可读标题。
 *
 * @param reportType planner 报告类型。
 * @returns 中文标题片段。
 */
function formatReportType(reportType: ReportPlanDto["reportType"]): string {
  switch (reportType) {
    case "company_brief":
      return "公司研究简报";
    case "earnings_review":
      return "业绩回顾";
    case "risk_review":
      return "风险审查";
    case "custom":
      return "自定义研究报告";
  }
}

/**
 * 将 Markdown 草稿转成最小 HTML 预览，避免本阶段引入 Markdown 渲染依赖。
 *
 * @param markdown Markdown 文本。
 * @returns 最小 HTML。
 */
function markdownToMinimalHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) {
        return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      }

      if (line.startsWith("## ")) {
        return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      }

      if (line.startsWith("- ")) {
        return `<p>${escapeHtml(line)}</p>`;
      }

      return line ? `<p>${escapeHtml(line)}</p>` : "";
    })
    .join("\n");
}

/**
 * 转义 HTML 特殊字符，防止报告草稿预览直接拼接未处理文本。
 *
 * @param value 原始文本。
 * @returns 转义后的文本。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 生成 report workflow run id。
 *
 * @param planId planner 输出 id。
 * @returns workflow run id。
 */
function createReportWorkflowRunId(planId: string): string {
  return `report_wf_${planId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
