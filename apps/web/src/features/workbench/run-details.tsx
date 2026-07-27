import type {
  AgentRunResponseDto,
  ApiError,
  ApiResult,
  ReportArtifactDto,
  ReportWorkflowResponseDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import {
  Activity,
  AlertTriangle,
  Braces,
  ChevronDown,
  Clock3,
  FilePlus2,
  FileText,
  ShieldCheck,
  Wrench,
  X
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { findMarketSeries, MarketCandlestickChart } from "../market-data";
import {
  formatApiError,
  formatEventSummary,
  formatEventTitle,
  formatLatency,
  formatRunProgress,
  formatTime,
  getApprovalRequests,
  parseApiResult
} from "./format";
import type { RunDetailSection, SelectedRunDetail, TraceEventDto } from "./types";

/**
 * 渲染 assistant 消息内的 run 派生详情，默认折叠减少调试信息干扰。
 *
 * @param props 组件属性。
 * @returns run 详情折叠区。
 */
export function RunDetails(props: {
  onOpen: (section: RunDetailSection) => void;
  reportMode: boolean;
  run: AgentRunResponseDto;
}) {
  const { run } = props;
  // MCP 调用与本地 registry 调用共享消息内工具列表，但保留各自 trace 类型便于辨识边界。
  const toolEvents = run.trace.events.filter(
    (event) => event.type === "tool_call" || event.type === "mcp_tool_call"
  );
  const approvalRequests = getApprovalRequests(run);
  const sections: Array<{ section: RunDetailSection; label: string; count?: number }> = [
    { section: "summary", label: "运行摘要" },
    { section: "steps", label: "Steps", count: run.steps.length },
    { section: "tools", label: "Tools", count: toolEvents.length },
    { section: "trace", label: "Trace", count: run.trace.events.length },
    ...(run.reportPlan || run.reportWorkflow ? [{ section: "report" as const, label: "Report" }] : []),
    ...(approvalRequests.length > 0
      ? [{ section: "approvals" as const, label: "Approvals", count: approvalRequests.length }]
      : [])
  ];

  return (
    <div className="run-details run-detail-types">
      <div className="run-detail-types-status">
        <Activity className="icon-size" />
        <StatusBadge tone="neutral">{run.intent}</StatusBadge>
        <StatusBadge tone={run.ok ? "success" : "danger"}>{run.ok ? "ok" : "failed"}</StatusBadge>
        <StatusBadge tone={props.reportMode ? "info" : "neutral"}>{props.reportMode ? "report" : "chat"}</StatusBadge>
      </div>
      <div className="run-detail-type-actions">
        {sections.map((item) => (
          <button key={item.section} onClick={() => props.onOpen(item.section)} type="button">
            <span>{item.label}</span>
            {item.count !== undefined ? <small>{item.count}</small> : null}
            <ChevronDown className="details-chevron" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 在右侧按需展示当前 assistant run 或实时事件，不形成永久调试侧栏。
 *
 * @param props 详情状态和审批操作。
 * @returns 可关闭的运行详情面板。
 */
export function RunDetailPanel(props: {
  approvalStatusById: Record<string, string>;
  detail?: SelectedRunDetail;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  onClose: () => void;
}) {
  if (!props.detail) return null;
  const run = props.detail?.run;
  const event = props.detail?.event;
  const section = props.detail.section ?? "summary";
  const toolEvents = run?.trace.events.filter((item) => item.type === "tool_call" || item.type === "mcp_tool_call") ?? [];
  const approvalRequests = run ? getApprovalRequests(run) : [];
  const marketSeries = findMarketSeries(event ?? run);
  return (
    <aside aria-label="运行详情" className="run-detail-panel is-open">
      <header className="run-detail-header">
        <div><p className="md-label">Agent activity</p><h2>{event?.type === "trace_event" ? formatEventTitle(event.event) : detailSectionTitle(section)}</h2></div>
        <button className="icon-button" onClick={props.onClose} type="button" aria-label="关闭运行详情"><X className="icon-size" /></button>
      </header>
      <div className="run-detail-scroll">
        {marketSeries ? <MarketCandlestickChart series={marketSeries} /> : null}
        {event ? <><p className="detail-lead">{formatRunProgress(event)}</p><JsonDetails title="event json" value={event} /></> : null}
        {run ? (
          <>
            {section === "summary" ? (
              <>
                <div className="run-identifiers"><span>requestId: {run.requestId}</span><span>traceId: {run.traceId}</span></div>
                <TraceSummaryPanel summary={run.trace.summary} />
                {run.error ? <ErrorBlock error={run.error} /> : null}
              </>
            ) : null}
            {section === "report" ? (
              <>
                {run.reportPlan ? <ReportPlanPanel plan={run.reportPlan} /> : null}
                {run.reportWorkflow ? <ReportWorkflowPanel workflow={run.reportWorkflow} /> : null}
              </>
            ) : null}
            {section === "approvals" ? <ApprovalRequestsPanel approvalStatusById={props.approvalStatusById} onApprovalDecision={props.onApprovalDecision} requests={approvalRequests} /> : null}
            {section === "steps" ? <RunStepsList steps={run.steps} /> : null}
            {section === "tools" ? <ToolCallsList events={toolEvents} /> : null}
            {section === "trace" ? <TraceTimeline events={run.trace.events} /> : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

/** @param section 当前详情类型。 @returns 右侧面板标题。 */
function detailSectionTitle(section: RunDetailSection): string {
  const titles: Record<RunDetailSection, string> = {
    summary: "运行摘要",
    steps: "Agent Steps",
    tools: "Tool Calls",
    trace: "Trace Timeline",
    report: "Report Workflow",
    approvals: "Approvals"
  };
  return titles[section];
}

/**
 * 展示后端聚合的请求级指标，Web 不重复计算事件明细。
 *
 * @param props trace 汇总 DTO。
 * @returns 指标摘要面板。
 */
export function TraceSummaryPanel(props: { summary: AgentRunResponseDto["trace"]["summary"] }) {
  const { summary } = props;
  return (
    <section className="details-section">
      <h3><Activity className="icon-size" />Trace summary</h3>
      <div className="trace-summary-grid">
        <span><strong>{summary.durationMs} ms</strong><small>latency</small></span>
        <span><strong>{summary.modelCallCount}</strong><small>model calls</small></span>
        <span><strong>{summary.toolCallCount}</strong><small>tool calls</small></span>
        <span><strong>{summary.knownTokenTotal}</strong><small>known tokens</small></span>
        <span><strong>{summary.unknownTokenCallCount}</strong><small>unknown usage</small></span>
        <span><strong>{summary.errorCount}</strong><small>errors</small></span>
      </div>
    </section>
  );
}

/**
 * 展示 Report planner 结构化输出摘要，完整 DTO 仍可在 run JSON 中查看。
 *
 * @param props 组件属性。
 * @returns report plan 摘要面板。
 */
export function ReportPlanPanel(props: { plan: NonNullable<AgentRunResponseDto["reportPlan"]> }) {
  const { plan } = props;

  return (
    <section className="details-section">
      <h3>
        <FileText className="icon-size" />
        Report plan
      </h3>
      <div className="report-plan-panel">
        <div className="report-plan-grid">
          <span>status</span>
          <strong>{plan.status}</strong>
          <span>trigger</span>
          <strong>{plan.triggerSource}</strong>
          <span>type</span>
          <strong>{plan.reportType}</strong>
          <span>subject</span>
          <strong>{plan.subject ?? "待确认"}</strong>
          <span>timeRange</span>
          <strong>{plan.timeRange ?? "待确认"}</strong>
          <span>data</span>
          <strong>{plan.requiredData.join(" / ")}</strong>
        </div>
        {plan.clarificationQuestions.length > 0 ? (
          <div className="report-plan-note">
            <strong>Clarification</strong>
            <span>{plan.clarificationQuestions.join("；")}</span>
          </div>
        ) : null}
        {plan.assumptions.length > 0 ? (
          <div className="report-plan-note">
            <strong>Assumptions</strong>
            <span>{plan.assumptions.join("；")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** 展示完整研报节点链路、artifact 预览和可追溯引用；运行逻辑始终留在 API/package。 */
export function ReportWorkflowPanel(props: { workflow: ReportWorkflowResponseDto }) {
  const { artifact, run } = props.workflow;
  const displayNodes = [
    { nodeId: "activation", title: "Activation", status: "succeeded", durationMs: 0 },
    { nodeId: "planner", title: "Planner", status: "succeeded", durationMs: 0 },
    ...run.nodes
  ];

  return (
    <section className="details-section report-workflow-section">
      <h3><Activity className="icon-size" />Report workflow</h3>
      <div className="workflow-header">
        <div className="run-identifiers"><span>workflowRunId: {run.runId}</span></div>
        <StatusBadge tone={run.status === "succeeded" ? "success" : run.status === "paused" ? "info" : "danger"}>{run.status}</StatusBadge>
      </div>
      {run.partial ? (
        <p className="workflow-recovery"><AlertTriangle className="icon-size" />部分数据源暂时不可用，已基于现有证据生成降级报告。请展开恢复详情核对数据缺口。</p>
      ) : null}
      {run.recovery && run.recovery.length > 0 ? <JsonDetails title="恢复与降级详情" value={run.recovery} /> : null}
      <div className="workflow-nodes">
        {displayNodes.map((node, index) => (
          <article className="workflow-node" key={node.nodeId}>
            <span className="workflow-index">{index + 1}</span>
            <div>
              <strong>{node.title}</strong>
              <small>{node.nodeId} · {node.durationMs} ms</small>
              {"inputSummary" in node && node.inputSummary ? <JsonDetails title="input summary" value={node.inputSummary} /> : null}
              {"outputSummary" in node && node.outputSummary ? <JsonDetails title="output summary" value={node.outputSummary} /> : null}
              {"error" in node && node.error ? <span className="workflow-error">{node.error.code}: {node.error.message}</span> : null}
            </div>
            <StatusBadge tone={node.status === "succeeded" ? "success" : node.status === "paused" ? "info" : node.status === "failed" ? "danger" : "neutral"}>{node.status}</StatusBadge>
          </article>
        ))}
      </div>
      {artifact ? <ReportArtifactPreview artifact={artifact} key={artifact.artifactId} /> : <p className="muted-row">Planner 尚未产出可预览报告。</p>}
    </section>
  );
}

/** 渲染报告 artifact，并通过 API 执行审批后的 PDF 生成与下载。 */
export function ReportArtifactPreview(props: { artifact: ReportArtifactDto }) {
  const [artifact, setArtifact] = useState(props.artifact);
  const [exportError, setExportError] = useState<string>();
  async function handlePdfExport(): Promise<void> {
    setExportError(undefined);
    const result = await exportReportPdf(artifact.artifactId);
    if (result.ok) setArtifact(result.data); else setExportError(formatApiError(result.error));
  }
  return (
    <div className="report-artifact">
      <div className="artifact-heading">
        <div><span className="md-label">Report preview</span><strong>{artifact.title}</strong></div>
        <div className="summary-badges">
          <StatusBadge tone="info">{artifact.status}</StatusBadge>
          <StatusBadge tone={artifact.citationVerification.verified ? "success" : "danger"}>
            citations {artifact.citationVerification.decision}
          </StatusBadge>
          <StatusBadge tone="info">PDF {artifact.pdfExport.status}</StatusBadge>
        </div>
      </div>
      <iframe className="report-html-preview" sandbox="" srcDoc={artifact.html} title="HTML report preview" />
      <details className="markdown-preview"><summary>Markdown source</summary><pre>{artifact.markdown}</pre></details>
      <div className="artifact-actions"><p className="pdf-placeholder"><AlertTriangle className="icon-size" />{artifact.pdfExport.message}</p>
        {artifact.pdfExport.status === "ready" && artifact.pdfExport.downloadUrl ? <a className="secondary-button" href={artifact.pdfExport.downloadUrl}><FileText className="icon-size" />Download PDF</a> : <button className="secondary-button" onClick={() => void handlePdfExport()} type="button"><FilePlus2 className="icon-size" />Generate PDF</button>}
      </div>
      {exportError ? <ErrorBlock error={{ code: "forbidden", message: exportError }} /> : null}
      <div className="citation-list">
        {artifact.citations.map((citation, index) => (
          <article className="citation-row" key={citation.id}>
            <strong>[{index + 1}]</strong>
            <div><span>{citation.quote}</span><small>{citation.source} / document {citation.documentId ?? "unknown"} / chunk {citation.chunkId ?? citation.chunkIndex ?? "unknown"}</small><small>supports: {citation.supportsFinding}</small></div>
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * 展示需要人工确认的敏感动作；按钮只提交 decision，不执行敏感逻辑。
 *
 * @param props 组件属性。
 * @returns approval request 面板。
 */
export function ApprovalRequestsPanel(props: {
  approvalStatusById: Record<string, string>;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  requests: ToolApprovalRequestDto[];
}) {
  return (
    <section className="details-section">
      <h3>
        <ShieldCheck className="icon-size" />
        Approvals
      </h3>
      <div className="detail-list">
        {props.requests.length === 0 ? <p className="muted-row">暂无人工确认请求。</p> : null}
        {props.requests.map((request) => {
          const status = props.approvalStatusById[request.approvalId] ?? "pending";
          const disabled = status === "submitting" || status === "approved" || status === "rejected";

          return (
            <article className="approval-row" key={request.approvalId}>
              <div>
                <strong>{request.toolName}</strong>
                <span>{request.reason}</span>
                <small>{request.approvalId}</small>
                <JsonDetails title="approval preview" value={request.inputPreview} />
              </div>
              <div className="approval-actions">
                <StatusBadge tone={status === "approved" ? "success" : status === "rejected" ? "danger" : "info"}>
                  {status}
                </StatusBadge>
                <button
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => void props.onApprovalDecision(request, "approved")}
                  type="button"
                >
                  <ShieldCheck className="icon-size" />
                  <span>Approve</span>
                </button>
                <button
                  className="secondary-button danger-action"
                  disabled={disabled}
                  onClick={() => void props.onApprovalDecision(request, "rejected")}
                  type="button"
                >
                  <X className="icon-size" />
                  <span>Reject</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 展示 Agent steps 的摘要列表，避免默认展示完整 JSON。
 *
 * @param props 组件属性。
 * @returns step 列表。
 */
export function RunStepsList(props: { steps: AgentRunResponseDto["steps"] }) {
  return (
    <section className="details-section">
      <h3>
        <Activity className="icon-size" />
        Steps
      </h3>
      <div className="detail-list">
        {props.steps.length === 0 ? <p className="muted-row">暂无 step。</p> : null}
        {props.steps.map((step) => (
          <article className="detail-row" key={`${step.index}-${step.type}`}>
            <div>
              <strong>
                {step.index}. {step.type}
              </strong>
              <span>{step.error?.message ?? `${step.durationMs} ms`}</span>
            </div>
            <StatusBadge tone={step.status === "succeeded" ? "success" : "danger"}>{step.status}</StatusBadge>
            <JsonDetails title="step json" value={step} />
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 展示工具调用摘要，工具参数和结果放入二级 JSON 折叠。
 *
 * @param props 组件属性。
 * @returns 工具调用列表。
 */
export function ToolCallsList(props: { events: TraceEventDto[] }) {
  return (
    <section className="details-section">
      <h3>
        <Wrench className="icon-size" />
        Tool calls
      </h3>
      <div className="detail-list">
        {props.events.length === 0 ? <p className="muted-row">暂无工具调用。</p> : null}
        {props.events.map((event) => (
          <article className="detail-row" key={event.id}>
            <div>
              <strong>{"toolName" in event ? event.toolName : "unknown tool"}</strong>
              <span>{formatEventSummary(event)}</span>
            </div>
            <StatusBadge tone={"ok" in event && event.ok ? "success" : "danger"}>{formatLatency(event)}</StatusBadge>
            <JsonDetails title="tool json" value={event} />
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 展示 trace 事件时间线，用摘要承载默认可读信息。
 *
 * @param props 组件属性。
 * @returns trace timeline。
 */
export function TraceTimeline(props: { events: TraceEventDto[] }) {
  const events = [...props.events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return (
    <section className="details-section">
      <h3>
        <Clock3 className="icon-size" />
        Trace timeline
      </h3>
      <div className="trace-list">
        {events.map((event, index) => (
          <article className="trace-row" key={event.id}>
            <span className="trace-index">{index + 1}</span>
            <div>
              <strong>{formatEventTitle(event)}</strong>
              <span>{formatEventSummary(event)}</span>
              <small>{formatTime(event.createdAt)}</small>
              {event.spanId ? <small>span {event.spanId} · parent {event.parentSpanId ?? "root"}</small> : null}
              <JsonDetails title="event json" value={event} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 以折叠方式展示 JSON，防止长 request payload 撑破对话区。
 *
 * @param props 组件属性。
 * @returns JSON 折叠块。
 */
export function JsonDetails(props: { title: string; value: unknown }) {
  return (
    <details className="json-details">
      <summary>
        <Braces className="icon-size" />
        {props.title}
      </summary>
      <pre>{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}

/**
 * 展示结构化错误，不暴露浏览器或服务端原始堆栈。
 *
 * @param props 组件属性。
 * @returns 错误摘要。
 */
export function ErrorBlock(props: { error: ApiError }) {
  return (
    <div className="error-block">
      <AlertTriangle className="icon-size" />
      <span>{formatApiError(props.error)}</span>
    </div>
  );
}

/**
 * 渲染小型状态标签，统一 run、会话和 composer 状态表达。
 *
 * @param props 组件属性。
 * @returns 状态标签。
 */
export function StatusBadge(props: { children: ReactNode; tone: "danger" | "info" | "neutral" | "success" }) {
  return <span className={`status-badge tone-${props.tone}`}>{props.children}</span>;
}

/** @param artifactId 服务端稳定 artifact ID。 @returns 更新后的真实 PDF 状态。 */
async function exportReportPdf(artifactId: string): Promise<ApiResult<ReportArtifactDto>> {
  return parseApiResult(await fetch(`/api/report-artifacts/${encodeURIComponent(artifactId)}/pdf`, { method: "POST" }));
}
