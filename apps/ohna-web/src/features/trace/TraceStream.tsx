/**
 * Trace 行视图：把投影后的行渲染成「文本 / 工具 / LLM 调用 / 终态 / 上下文事件」五类块。
 *
 * 为什么不复用 chat 时间线：chat 的时间线以对话消息为主体、运行细节折叠进 assistant 消息；
 * 观测台要的是**按事件顺序平铺**的完整执行轨迹（含每次 LLM 请求），语义不同。
 *
 * v2.0 变化：
 * - 每行带 `agentId`，执行地图的「点击 Team 卡高亮/滚动」据此定位（`.trace-row-agent`）；
 * - LLM 调用块改为视口惰性挂载（`VirtualizedLlmCallBlock`），500+ 事件不一次挂载全部 raw；
 * - 新增 `context` 行（compaction 等上下文事件），与 Events 面板同源同文案。
 */
import { AlertTriangle, ChevronDown, Scissors, Wrench } from "lucide-react";
import { JsonViewer } from "../json-viewer/index.js";
import { VirtualizedLlmCallBlock } from "./LlmCallBlock.virtual.js";
import { formatDelta, formatNumber } from "./trace-labels";
import type { TraceRow } from "./trace-projection";

/**
 * 渲染 Trace 行列表。
 *
 * @param props.rows 投影后的行。
 * @param props.isLoading 是否正在加载（replay 尚未返回首帧）。
 * @param props.emptyText 可选空态文案（渲染预算占位场景会给出更短的一句）。
 * @returns 时间线。
 */
export function TraceStream(props: { rows: TraceRow[]; isLoading?: boolean; emptyText?: string }) {
  if (props.isLoading && props.rows.length === 0) {
    return <p className="muted-row trace-empty">正在回放事件…</p>;
  }
  if (props.rows.length === 0) {
    return (
      <p className="muted-row trace-empty">
        {props.emptyText ??
          "该 run 暂无事件。CLI 镜像 run 只记录 LLM 请求/响应与 loop 事件，不会写入会话消息。"}
      </p>
    );
  }
  return <TraceRowList rows={props.rows} />;
}

/**
 * 行列表主体（无空态包装，供 TurnGroup 内嵌复用）。
 *
 * @param props.rows 投影后的行。
 * @param props.activeAgentId 当前选中的 agent（Team 卡点击后写入）；命中的行加高亮，其余行照常渲染。
 * @returns 行容器。
 */
export function TraceRowList(props: { rows: TraceRow[]; activeAgentId?: string | undefined }) {
  return (
    <div className="trace-rows">
      {props.rows.map((row) => (
        <TraceRowView activeAgentId={props.activeAgentId} key={row.key} row={row} />
      ))}
    </div>
  );
}

/**
 * 单行渲染（执行地图按行归属做高亮，所以每行都带 `data-agent-key`）。
 *
 * 高亮口径：`row.agentId === activeAgentId` 时加 `.is-agent-active`。执行地图**不隐藏**
 * 其他 agent 的行——Team 场景下同一个 turn 桶里本来就混有多种归属（子代理 turn 内会有
 * 主线程派发它的工具调用、主线程 turn 内会有子代理的交错事件），隐藏会让「这一轮到底发生
 * 了什么」失真，因此联动只做「提亮 + 滚动」。
 *
 * @param props.row 投影行。
 * @param props.activeAgentId 当前选中的 agent；undefined 表示无选中。
 * @returns 行元素。
 */
export function TraceRowView(props: { row: TraceRow; activeAgentId?: string | undefined }) {
  const row = props.row;
  const active = props.activeAgentId !== undefined && props.activeAgentId === row.agentId;
  /** 行级联动属性：CSS 高亮类 + 供读屏/测试断言的选中归属。 */
  const linkProps = {
    "aria-current": active ? ("true" as const) : undefined,
    "data-agent-active": active ? "true" : undefined
  };
  const rowClass = (base: string): string =>
    [base, "trace-map-row", active ? "is-agent-active" : ""].filter(Boolean).join(" ");
  switch (row.kind) {
    case "llm":
      return (
        <div className={rowClass("trace-llm-row")} data-agent-key={row.agentId} {...linkProps}>
          <VirtualizedLlmCallBlock idSuffix={row.key} record={row.record} />
        </div>
      );
    case "message":
      return (
        <article
          className={rowClass(`trace-message is-${row.role}`)}
          data-agent-key={row.agentId}
          {...linkProps}
        >
          <header>
            <span className="md-label">{row.role === "user" ? "user" : row.role}</span>
            <span className="trace-row-agent">{row.agentId}</span>
            {row.live ? <span className="trace-live-dot" aria-label="流式接收中" /> : null}
          </header>
          <p>{row.text || "（空消息）"}</p>
        </article>
      );
    case "tool":
      return (
        <details className={rowClass("trace-tool")} data-agent-key={row.agentId} {...linkProps}>
          <summary>
            <ChevronDown className="icon-size details-chevron" />
            <Wrench className="icon-size" />
            <span className="trace-tool-name">{row.toolName}</span>
            <span className="trace-row-agent">{row.agentId}</span>
            {row.isError ? <span className="md-badge md-badge-danger">error</span> : null}
            {row.done ? null : <span className="md-badge md-badge-info">running</span>}
          </summary>
          <div className="trace-tool-body">
            <div>
              <p className="md-label">参数</p>
              <JsonViewer className="trace-json-viewer" value={row.args ?? null} />
            </div>
            {row.done ? (
              <div>
                <p className="md-label">结果</p>
                <JsonViewer className="trace-json-viewer" value={row.result ?? null} />
              </div>
            ) : null}
          </div>
        </details>
      );
    case "context":
      return (
        <div className={rowClass("trace-context-row")} data-agent-key={row.agentId} {...linkProps}>
          <Scissors className="icon-size" aria-hidden />
          <span className="md-badge md-badge-info">{row.eventKind}</span>
          <span className="trace-context-delta">{formatDelta(row.delta)} tokens</span>
          <span className="trace-context-detail">
            {formatNumber(row.before)} → {formatNumber(row.after)}
            {row.detail ? ` · ${row.detail}` : ""}
          </span>
        </div>
      );
    case "terminal":
      return (
        <div
          className={rowClass(`trace-terminal is-${row.status ?? "unknown"}`)}
          data-agent-key={row.agentId}
          {...linkProps}
        >
          {row.status === "failed" ? <AlertTriangle className="icon-size" /> : null}
          <span>run {row.status ?? "unknown"}</span>
          {row.message ? <code>{row.message}</code> : null}
        </div>
      );
    default:
      return null;
  }
}
