import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type { DataSourceRuntime } from "@aiagent/rag";
import type { ReportArtifactDto, ReportPlanDto, ReportCitationDto } from "@aiagent/types";
import { z } from "zod";
import { runReportWorkflow } from "./run-report-workflow.js";
import { renderResearchReportPdf } from "./pdf.js";
import { publishArtifactPdf } from "./publish-artifact-pdf.js";
import type {
  ArtifactRecord,
  ArtifactRepository,
  ArtifactStorage,
  WorkflowRepository
} from "./persistence.js";
import type { ReportWorkflowState } from "./workflow-types.js";

/**
 * generate_report 工具的参数 schema：模型只需给出研究对象，
 * scope/focus 作为可选约束并入 plan 假设，由六节点 workflow 负责证据收集与写作。
 */
const reportToolParametersSchema = z.object({
  subject: z.string().min(1).describe("研究对象：A 股 ticker（如 000001.SZ）或公司/行业名称"),
  scope: z.string().optional().describe("研究范围或时间范围（如 最近两年、2024 年报）"),
  focus: z.array(z.string()).optional().describe("重点关注的数据域，如 filings / financial_metrics / risk_factors")
});

type ReportToolParams = z.infer<typeof reportToolParametersSchema>;

/**
 * 工具观测事件出口：只有 workflow_node / pdf_export 两类稳定事件进入 run_events；
 * 节点内部辅助事件（tool_call、citation_verifier）留在 workflow 层，不穿透到调用方。
 */
export type ReportToolEventSink = (event: {
  type: "workflow_node" | "pdf_export";
  payload: Record<string, unknown>;
}) => Promise<void>;

export interface ReportToolOptions {
  /** RAG runtime；缺省时 data collector 节点内部自建内存 runtime。 */
  dataSourceRuntime?: DataSourceRuntime;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  artifactStorage: ArtifactStorage;
  /** 服务端确认的用户 ID，workflow/artifact 持久化的归属上下文。 */
  ownerUserId: string;
  conversationId: string;
  agentRunId: string;
  /** 节点事件 sink（由 run-service 转接 run_events 落库 + SSE 广播）。 */
  sink: ReportToolEventSink;
  /** 单次工具执行的 deadline 预算（毫秒），透传给 workflow runtime。 */
  deadlineMs?: number;
  now?: () => Date;
}

/** 工具结果 details 形状（仅供 trace/UI，不进 LLM 上下文）。 */
export interface ReportToolDetails {
  workflowRunId: string;
  artifactId: string;
  plan: ReportPlanDto;
  citations: ReportCitationDto[];
  pdfStatus: "ready" | "failed";
  downloadUrl?: string;
}

/**
 * 把 report workflow 注册为 loop 工具 generate_report（pi 化阶段 5，方案 A）：
 * report 从「API 层编排」降级为模型自主调用的普通工具，approval 门删除后
 * PDF 在工具内直接发布（publishArtifactPdf saga），事件名 workflow_node / pdf_export 保持不变。
 *
 * @param options 持久化端口、归属上下文与事件 sink。
 * @returns 可直接并入 agentLoop config.tools 的 AgentTool。
 */
export function createReportTool(options: ReportToolOptions): AgentTool<typeof reportToolParametersSchema, ReportToolDetails> {
  const now = options.now ?? (() => new Date());
  return {
    name: "generate_report",
    label: "生成研究报告",
    description:
      "生成一份完整的金融研究报告（含数据收集、分析、风险检查、引用校验、写作与 PDF 导出）。"
      + "当用户明确要求研报/研究报告/深度报告时必须调用本工具，不要只用文字答复。",
    parameters: reportToolParametersSchema,
    execute: async (_toolCallId, params, signal) => executeReportTool(options, now, params, signal)
  };
}

/**
 * 工具执行主流程：构造 ready plan → 跑六节点 workflow → 持久化 workflow 与草稿 artifact
 * → 直接发布真实 PDF → 汇总工具结果。失败抛带 code/details 的 Error，由 loop 转 isError ToolResultMessage。
 *
 * @param options 工具装配选项。
 * @param now 时钟工厂。
 * @param params 已校验参数。
 * @param signal run 级 AbortSignal。
 * @returns 结构化工具结果。
 */
async function executeReportTool(
  options: ReportToolOptions,
  now: () => Date,
  params: ReportToolParams,
  signal?: AbortSignal
): Promise<AgentToolResult<ReportToolDetails>> {
  const plan = createExecutablePlan(params, now);
  const workflowRunId = `report_wf_${plan.planId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // 时序完整性：approval 门删除前的 queued 事件改由工具层在 workflow 开始前发出。
  await emitPdfExport(options.sink, workflowRunId, "queued", {});

  const result = await runReportWorkflow(plan, {
    runId: workflowRunId,
    dataSourceRuntime: options.dataSourceRuntime,
    deadlineMs: options.deadlineMs,
    signal,
    sink: async (event) => {
      // 节点辅助事件（tool_call / citation_verifier）不进入 run_events，只转发稳定事件名。
      if (event.type !== "workflow_node" && event.type !== "pdf_export") return;
      try {
        await options.sink({ type: event.type, payload: event.payload });
      } catch {
        // sink 是旁路观测出口：run_events 落库瞬时失败不得把一个已成功的 report run 变成工具错误。
      }
    }
  });

  if (!result.ok) {
    await emitPdfExport(options.sink, workflowRunId, "failed", { error: result.error });
    throw createReportToolError("report_workflow_failed", `研报 workflow 执行失败：${result.error.message}`, {
      workflowRunId,
      planId: plan.planId,
      workflowError: result.error
    });
  }

  await options.workflowRepository.save({
    context: {
      userId: options.ownerUserId,
      conversationId: options.conversationId,
      agentRunId: options.agentRunId,
      planId: plan.planId
    },
    run: result.run
  });

  const createdAt = now().toISOString();
  const artifactId = `artifact_${result.run.runId}`;
  const artifact = createDraftArtifact(result.state, result.run.runId, artifactId, createdAt);
  const record = await options.artifactRepository.save(createArtifactRecord(options, artifact, createdAt));

  const published = await publishArtifactPdf(
    record,
    options.artifactRepository,
    options.artifactStorage,
    () => renderResearchReportPdf({
      title: artifact.title,
      generatedAt: artifact.createdAt,
      markdown: artifact.markdown,
      citations: artifact.citations
    }),
    now
  );

  const pdfStatus = published.ok ? "ready" : "failed";
  await emitPdfExport(options.sink, workflowRunId, pdfStatus, {
    fileName: published.ok ? published.artifact.pdfExport.fileName : undefined,
    downloadUrl: published.ok ? published.artifact.pdfExport.downloadUrl : undefined,
    failurePhase: published.ok ? undefined : published.phase
  });

  const finalArtifact = published.ok ? published.artifact : artifact;
  return {
    content: [
      {
        type: "text",
        text: formatReportToolText(finalArtifact, result.state, pdfStatus)
      }
    ],
    details: {
      workflowRunId: result.run.runId,
      artifactId,
      plan,
      citations: artifact.citations,
      pdfStatus,
      downloadUrl: published.ok ? published.artifact.pdfExport.downloadUrl : undefined
    }
  };
}

/**
 * 由工具参数构造可直接执行的 ready plan（report-planner 特例路径删除后，
 * plan 构造内联在工具内：模型已经把研究对象提取为结构化参数，无需再做自然语言规划）。
 *
 * @param params 工具参数。
 * @param now 时钟工厂。
 * @returns status 为 ready 的 ReportPlanDto。
 */
function createExecutablePlan(params: ReportToolParams, now: () => Date): ReportPlanDto {
  const focus = params.focus ?? [];
  const requiredData = new Set<string>(["filings", "financial_metrics"]);
  if (focus.some((item) => /风险|risk/i.test(item))) requiredData.add("risk");
  const assumptions = [
    "研报由 generate_report 工具触发，plan 由工具参数直接构造。",
    ...(params.scope ? [] : ["未指定时间范围，默认使用最近两年可获得公告和财务数据。"]),
    ...focus.map((item) => `重点关注：${item}`)
  ];
  return {
    planId: `report_plan_tool_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "ready",
    triggerSource: "natural_language",
    reportType: focus.some((item) => /风险|risk/i.test(item)) ? "risk_review" : "company_brief",
    subject: params.subject,
    timeRange: params.scope ?? "最近两年",
    requiredData: [...requiredData],
    assumptions,
    clarificationQuestions: [],
    steps: [
      {
        id: "collect_filings",
        kind: "collect_filings",
        title: "收集公告和财报",
        description: "检索研究对象在时间范围内的公告、年报和季报文本。",
        requiredData: ["filings"],
        optional: false
      },
      {
        id: "collect_financial_metrics",
        kind: "collect_financial_metrics",
        title: "收集财务指标",
        description: "拉取营收、净利润、ROE、现金流等核心财务指标。",
        requiredData: ["financial_metrics"],
        optional: false
      },
      {
        id: "analyze_findings",
        kind: "analyze_findings",
        title: "分析发现",
        description: "归纳业务、财务和风险变化，形成可审查结论。",
        requiredData: [...requiredData],
        optional: false
      },
      {
        id: "draft_report",
        kind: "draft_report",
        title: "起草报告",
        description: "生成结构化研报正文草稿，不输出评级或目标价。",
        requiredData: [...requiredData],
        optional: false
      }
    ]
  };
}

/**
 * 由 workflow 终态构造草稿 artifact DTO（artifactId 约定 artifact_${workflowRunId}，
 * 与 GET /api/report-workflows/:runId 的读取约定一致）。
 *
 * @param state workflow 终态。
 * @param workflowRunId workflow run id。
 * @param artifactId artifact id。
 * @param createdAt 创建时间。
 * @returns html_preview_only 状态的 ReportArtifactDto。
 */
function createDraftArtifact(
  state: ReportWorkflowState,
  workflowRunId: string,
  artifactId: string,
  createdAt: string
): ReportArtifactDto {
  const draft = state.draft;
  const citations = state.citations;
  if (!draft || !citations) {
    // runReportWorkflow ok 时必有 draft/export；citations 由 verifier 节点保证。
    throw createReportToolError("report_state_incomplete", "研报 workflow 完成但缺少草稿或引用状态。", { workflowRunId });
  }
  return {
    artifactId,
    reportId: state.plan.planId,
    workflowRunId,
    status: "html_preview_only",
    title: draft.title,
    markdown: draft.markdown,
    html: draft.html,
    citations: citations.citations,
    citationVerification: {
      decision: citations.decision,
      verified: citations.verified,
      missingClaims: citations.missingClaims,
      missingMetrics: citations.missingMetrics
    },
    pdfExport: {
      status: "queued",
      fileName: state.export?.fileName,
      message: state.export?.message ?? "PDF 导出由 generate_report 工具直接执行。"
    },
    createdAt
  };
}

/**
 * 组装 artifact 持久化 record（markdown 草稿本体，mediaType text/html；PDF 发布 saga 会更新为 application/pdf）。
 *
 * @param options 工具装配选项。
 * @param artifact 草稿 artifact DTO。
 * @param createdAt 创建时间。
 * @returns 可提交的 ArtifactRecord。
 */
function createArtifactRecord(
  options: ReportToolOptions,
  artifact: ReportArtifactDto,
  createdAt: string
): ArtifactRecord {
  return {
    artifact,
    userId: options.ownerUserId,
    conversationId: options.conversationId,
    agentRunId: options.agentRunId,
    kind: "research_report",
    mediaType: "text/html",
    metadata: {},
    updatedAt: createdAt
  };
}

/**
 * 生成回喂模型的工具结果文本：草稿摘要、章节、artifact 引用与 PDF 下载链接。
 *
 * @param artifact 最终 artifact（PDF 就绪时含 downloadUrl）。
 * @param state workflow 终态。
 * @param pdfStatus PDF 发布结果。
 * @returns 多行摘要文本。
 */
function formatReportToolText(
  artifact: ReportArtifactDto,
  state: ReportWorkflowState,
  pdfStatus: "ready" | "failed"
): string {
  const lines = [
    `研究报告已生成：${artifact.title}`,
    `研究对象：${state.plan.subject ?? "未指定"}；章节数：${state.draft?.sectionCount ?? 0}；引用数：${artifact.citations.length}`,
    `artifactId：${artifact.artifactId}`,
    pdfStatus === "ready" && artifact.pdfExport.downloadUrl
      ? `PDF 下载：${artifact.pdfExport.downloadUrl}`
      : "PDF 生成失败，可稍后通过 artifact 重试导出。",
    "",
    "草稿摘要：",
    artifact.markdown.slice(0, 400),
    "",
    ...(artifact.citations.length > 0
      ? ["引用：", ...artifact.citations.map((citation, index) => `[${index + 1}] ${citation.source} — ${citation.quote.slice(0, 120)}`)]
      : ["引用：无（证据不足，草稿已标注资料不足）。"])
  ];
  return lines.join("\n");
}

/**
 * 经 sink 发出 pdf_export 事件（payload 与原 trace 事件本体同形状）。
 *
 * @param sink 工具事件出口。
 * @param workflowRunId workflow run id。
 * @param status 导出状态。
 * @param extra 附加字段（downloadUrl / failurePhase / error）。
 * @returns sink 完成 Promise。
 */
async function emitPdfExport(
  sink: ReportToolEventSink,
  workflowRunId: string,
  status: "queued" | "ready" | "failed",
  extra: Record<string, unknown>
): Promise<void> {
  try {
    await sink({
      type: "pdf_export",
      payload: {
        workflowRunId,
        status,
        durationMs: 0,
        createdAt: new Date().toISOString(),
        ...extra
      }
    });
  } catch {
    // 与 emitWorkflowNodeEvent 同一约定：观测事件失败不影响工具主流程（）。
  }
}

/**
 * 构造带结构化 code/details 的工具错误；loop 会转成 isError ToolResultMessage 回喂模型。
 *
 * @param code 稳定错误码。
 * @param message 面向调用方的错误描述。
 * @param details 结构化细节。
 * @returns 带 code/details 的 Error。
 */
function createReportToolError(code: string, message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, details });
}
