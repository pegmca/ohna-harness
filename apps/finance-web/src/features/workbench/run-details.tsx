import type { ApiError } from "@aiagent/types";
import {
  Activity,
  AlertTriangle,
  Braces,
  ChevronDown,
  Wrench,
  X
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { findMarketSeries, MarketCandlestickChart } from "../market-data";
import { formatApiError } from "./format";
import type { RunDetailSection, SelectedRunDetail, UiToolCallBlock } from "./types";

export { RunDetails } from "./run-process";

/**
 * 在右侧按需展示当前 assistant 消息的运行详情，不形成永久调试侧栏。
 * 数据全部从消息块与 live 事件派生（新协议 snapshot 不再携带 trace/steps/result）。
 *
 * @param props 详情状态。
 * @returns 可关闭的运行详情面板。
 */
export function RunDetailPanel(props: {
  detail?: SelectedRunDetail;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    if (!props.detail) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panelRef.current?.focus();

    /**
     * 支持 ESC 关闭详情，并把焦点归还给打开抽屉的触发按钮。
     *
     * @param event 键盘事件。
     * @returns void。
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [props.detail]);

  if (!props.detail) return null;
  const message = props.detail.message;
  const event = props.detail.event;
  const section = props.detail.section ?? "summary";
  const toolBlocks = (message?.blocks ?? []).filter(
    (block): block is UiToolCallBlock => block.type === "toolCall"
  );
  const marketSeries = findMarketSeries(message?.blocks ?? event);
  return (
    <aside
      aria-label="运行详情"
      aria-modal="true"
      className="run-detail-panel is-open"
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="run-detail-header">
        <div><p className="md-label">Agent activity</p><h2>{detailSectionTitle(section)}</h2></div>
        <button className="icon-button" onClick={props.onClose} type="button" aria-label="关闭运行详情"><X className="icon-size" /></button>
      </header>
      <div className="run-detail-scroll">
        {marketSeries ? <MarketCandlestickChart series={marketSeries} /> : null}
        {event ? <JsonDetails title="event json" value={event} /> : null}
        {message ? (
          <>
            {section === "summary" ? (
              <>
                <RunActivityOverview message={message} toolCount={toolBlocks.length} />
                {message.error ? <ErrorBlock error={message.error} /> : null}
                <details className="developer-details">
                  <summary className="developer-detail-trigger">
                    <span>开发者详情</span>
                    <ChevronDown className="details-chevron" />
                  </summary>
                  <div className="run-identifiers">
                    <span>runId: {message.runId ?? "unknown"}</span>
                    <span>modelId: {message.modelId ?? "unknown"}</span>
                  </div>
                  <ToolCallsList tools={toolBlocks} />
                  {message.liveEvents && message.liveEvents.length > 0 ? (
                    <JsonDetails title="run events" value={message.liveEvents} />
                  ) : null}
                </details>
              </>
            ) : null}
            {section === "tools" ? <ToolCallsList tools={toolBlocks} /> : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 用用户可理解的语言概括本次回答过程，原始事件留在开发者详情中。
 *
 * @param props 消息与工具调用数量。
 * @returns 活动概览。
 */
function RunActivityOverview(props: { message: SelectedRunDetail["message"] & object; toolCount: number }) {
  const { message } = props;
  const failed = message.status === "failed" || message.ok === false;
  return (
    <section className="details-section run-activity-overview">
      <h3><Activity className="icon-size" />回答过程</h3>
      <p>{failed ? "运行未能完成，请查看错误信息或重新生成。" : "已完成问题分析并生成回答。"}</p>
      <div className="summary-badges">
        <StatusBadge tone={failed ? "danger" : "success"}>{failed ? "失败" : "已完成"}</StatusBadge>
        {props.toolCount > 0 ? <StatusBadge tone="info">{props.toolCount} 个工具</StatusBadge> : null}
        {message.runStatus ? <StatusBadge tone="neutral">{message.runStatus}</StatusBadge> : null}
      </div>
    </section>
  );
}

/** @param section 当前详情类型。 @returns 右侧面板标题。 */
function detailSectionTitle(section: RunDetailSection): string {
  const titles: Record<RunDetailSection, string> = {
    summary: "回答过程",
    tools: "Tool Calls"
  };
  return titles[section];
}

/**
 * 展示工具调用摘要，参数与结果放入二级 JSON 折叠。
 *
 * @param props 组件属性。
 * @returns 工具调用列表。
 */
export function ToolCallsList(props: { tools: UiToolCallBlock[] }) {
  return (
    <section className="details-section">
      <h3>
        <Wrench className="icon-size" />
        Tool calls
      </h3>
      <div className="detail-list">
        {props.tools.length === 0 ? <p className="muted-row">暂无工具调用。</p> : null}
        {props.tools.map((tool) => (
          <article className="detail-row" key={tool.id}>
            <div>
              <strong>{tool.name}</strong>
              <span>{tool.result?.isError ? "工具调用失败。" : "工具已返回结构化结果。"}</span>
            </div>
            <StatusBadge tone={tool.result?.isError || tool.status === "failed" ? "danger" : "success"}>
              {tool.status ?? "completed"}
            </StatusBadge>
            <JsonDetails title="tool json" value={tool} />
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
