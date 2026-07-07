import type { TraceRecorder } from "@aiagent/trace";
import type { ReportPlanDto, WorkflowErrorDto, WorkflowRunDto } from "@aiagent/types";
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

export const reportDataCollectorInputSchema = z.object({
  plan: reportPlanSchema
});

export const reportDataCollectorOutputSchema = z.object({
  subject: z.string(),
  timeRange: z.string(),
  filings: z.array(z.string()),
  financialMetrics: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      period: z.string()
    })
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      quote: z.string()
    })
  )
});

export const reportAnalyzerInputSchema = z.object({
  plan: reportPlanSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportAnalyzerOutputSchema = z.object({
  thesis: z.string(),
  findings: z.array(z.string()),
  evidenceIds: z.array(z.string())
});

export const reportRiskCheckerInputSchema = z.object({
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportRiskCheckerOutputSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high"]),
  riskItems: z.array(z.string()),
  passed: z.boolean()
});

export const reportCitationVerifierInputSchema = z.object({
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportCitationVerifierOutputSchema = z.object({
  verified: z.boolean(),
  citations: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      quote: z.string(),
      supportsFinding: z.string()
    })
  ),
  missingCitationFindings: z.array(z.string())
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

export interface ReportWorkflowState extends WorkflowState {
  plan: ReportPlanDto;
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
  trace?: TraceRecorder;
}

export type ReportWorkflowResult =
  | {
      ok: true;
      run: WorkflowRunDto;
      state: ReportWorkflowState;
      draft: ReportWriterOutput;
      export: ReportPdfExporterOutput;
    }
  | {
      ok: false;
      run: WorkflowRunDto;
      state: ReportWorkflowState;
      error: WorkflowErrorDto;
    };

export interface ReportPackageSummary {
  packageName: "@aiagent/report";
  boundary: "report_workflow_nodes_writer_export_adapter";
  runtimeState: "mock_nodes_ready";
}

/**
 * 创建 report package 摘要，说明本阶段只实现 mock 节点和导出占位。
 *
 * @returns report package 当前能力摘要。
 */
export function createReportPackageSummary(): ReportPackageSummary {
  return {
    packageName: "@aiagent/report",
    boundary: "report_workflow_nodes_writer_export_adapter",
    runtimeState: "mock_nodes_ready"
  };
}

/**
 * 从 Report Planner 输出执行最小 Report Workflow：收集、分析、风控、引用校验、写作和 PDF 占位。
 *
 * @param plan Report Planner 输出。
 * @param options max steps、trace 和 run id。
 * @returns 结构化 workflow 结果。
 */
export async function runReportWorkflow(
  plan: ReportPlanDto,
  options: RunReportWorkflowOptions = {}
): Promise<ReportWorkflowResult> {
  const readyError = validateExecutablePlan(plan);
  const initialState: ReportWorkflowState = {
    plan
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
        maxSteps: options.maxSteps ?? 12,
        executedSteps: 0,
        nodes: createReportWorkflowNodes().map((node) => ({
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
    nodes: createReportWorkflowNodes(),
    maxSteps: options.maxSteps,
    trace: options.trace
  });

  if (!result.ok) {
    return result;
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
    run: result.run,
    state: result.state,
    draft: result.state.draft,
    export: result.state.export
  };
}

/**
 * 创建 Report Workflow 节点定义，每个节点都显式声明 input/output schema。
 *
 * @returns 顺序节点定义。
 */
export function createReportWorkflowNodes(): AnyWorkflowNodeDefinition<ReportWorkflowState>[] {
  return [
    createDataCollectorNode(),
    createAnalyzerNode(),
    createRiskCheckerNode(),
    createCitationVerifierNode(),
    createReportWriterNode(),
    createPdfExporterNode()
  ];
}

/**
 * 创建固定顺序的 report workflow edges，供 invalid plan 失败 run 也能展示结构。
 *
 * @returns edge DTO。
 */
function createReportWorkflowEdges(): { from: string; to: string }[] {
  const nodes = createReportWorkflowNodes();
  return nodes.slice(0, -1).map((node, index) => ({
    from: node.nodeId,
    to: nodes[index + 1].nodeId
  }));
}

/**
 * Data Collector mock 节点，后续会替换为真实工具/RAG 数据收集。
 *
 * @returns workflow node definition。
 */
function createDataCollectorNode(): WorkflowNodeDefinition<ReportDataCollectorInput, ReportDataCollectorOutput, ReportWorkflowState> {
  return {
    nodeId: "data_collector",
    type: "report.data_collector",
    title: "Data Collector",
    inputSchema: reportDataCollectorInputSchema,
    outputSchema: reportDataCollectorOutputSchema,
    buildInput: (state) => ({
      plan: state.plan
    }),
    execute: (input) => {
      const subject = input.plan.subject;

      if (!subject) {
        throw new Error("Report workflow requires plan.subject before collecting data.");
      }

      const timeRange = input.plan.timeRange ?? "最近两年";
      const filings = input.plan.requiredData.includes("filings")
        ? [`${subject} ${timeRange} 年报摘要`, `${subject} ${timeRange} 重要公告摘要`]
        : [];
      const financialMetrics = input.plan.requiredData.includes("financial_metrics")
        ? [
            {
              name: "net_profit",
              value: "mock 同比增长",
              period: timeRange
            },
            {
              name: "roe",
              value: "mock 保持稳定",
              period: timeRange
            }
          ]
        : [];

      return {
        subject,
        timeRange,
        filings,
        financialMetrics,
        evidence: [
          {
            id: "evidence_001",
            source: "mock_filing_search",
            quote: `${subject} 在 ${timeRange} 的经营表现保持稳定。`
          },
          {
            id: "evidence_002",
            source: "mock_financial_metric",
            quote: `${subject} 核心财务指标用于支撑本报告初稿。`
          }
        ]
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      collectedData: output
    }),
    summarizeInput: (input) => ({
      planId: input.plan.planId,
      subject: input.plan.subject,
      requiredData: input.plan.requiredData
    }),
    summarizeOutput: (output) => ({
      subject: output.subject,
      timeRange: output.timeRange,
      filingCount: output.filings.length,
      metricCount: output.financialMetrics.length,
      evidenceCount: output.evidence.length
    })
  };
}

/**
 * Analyzer mock 节点，将收集到的数据转成研报发现。
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
    execute: (input) => ({
      thesis: `${input.collectedData.subject} ${input.plan.reportType} 初步结论：业务与财务表现具备继续研究价值。`,
      findings: [
        `${input.collectedData.subject} 在 ${input.collectedData.timeRange} 的公告证据数量为 ${input.collectedData.filings.length}。`,
        `财务指标样本数量为 ${input.collectedData.financialMetrics.length}，可支撑初版趋势判断。`
      ],
      evidenceIds: input.collectedData.evidence.map((item) => item.id)
    }),
    applyOutput: (state, output) => ({
      ...state,
      analysis: output
    }),
    summarizeInput: (input) => ({
      subject: input.collectedData.subject,
      reportType: input.plan.reportType
    }),
    summarizeOutput: (output) => ({
      findingCount: output.findings.length,
      evidenceIdCount: output.evidenceIds.length
    })
  };
}

/**
 * Risk Checker mock 节点，输出报告写作前的风险约束。
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
      analysis: state.analysis,
      collectedData: state.collectedData
    }),
    execute: (input) => {
      const hasRiskData = input.collectedData.evidence.some((item) => item.quote.includes("风险"));
      return {
        riskLevel: hasRiskData ? "medium" : "low",
        riskItems: [
          "当前为 mock 数据路径，不能作为投资建议。",
          "后续需要 Citation Verifier 对关键结论进行二次检索校验。"
        ],
        passed: true
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      risks: output
    }),
    summarizeOutput: (output) => ({
      riskLevel: output.riskLevel,
      riskCount: output.riskItems.length,
      passed: output.passed
    })
  };
}

/**
 * Citation Verifier mock 节点，确认分析发现是否能映射到现有 evidence。
 *
 * @returns workflow node definition。
 */
function createCitationVerifierNode(): WorkflowNodeDefinition<
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
      collectedData: state.collectedData
    }),
    execute: (input) => {
      const citations = input.collectedData.evidence.map((item, index) => ({
        id: item.id,
        source: item.source,
        quote: item.quote,
        supportsFinding: input.analysis.findings[index] ?? input.analysis.thesis
      }));

      return {
        verified: citations.length > 0,
        citations,
        missingCitationFindings: citations.length > 0 ? [] : input.analysis.findings
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      citations: output
    }),
    summarizeOutput: (output) => ({
      verified: output.verified,
      citationCount: output.citations.length,
      missingCount: output.missingCitationFindings.length
    })
  };
}

/**
 * Report Writer mock 节点，生成 Markdown/HTML 草稿。
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
      const markdown = [
        `# ${title}`,
        "",
        "## 核心结论",
        input.analysis.thesis,
        "",
        "## 关键发现",
        ...input.analysis.findings.map((finding, index) => `- ${finding} [^${Math.min(index + 1, citationLines.length || 1)}]`),
        "",
        "## 风险提示",
        ...input.risks.riskItems.map((risk) => `- ${risk}`),
        "",
        "## 引用",
        ...citationLines
      ].join("\n");

      return {
        title,
        markdown,
        html: markdownToMinimalHtml(markdown),
        sectionCount: 4,
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
    execute: (input) => ({
      status: "placeholder",
      fileName: `${input.draft.title.replace(/\s+/g, "_")}.pdf`,
      mimeType: "application/pdf",
      message: "PDF 导出在后续阶段接入；当前节点只保留导出占位结构。"
    }),
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
