/**
 * Trace 右侧抽屉（03 D3 / v2.0 04 §5.5）：chat 页内的可折叠排查位，数据跟随当前会话。
 *
 * 为什么从独立页降级为抽屉：trace 是「排查问题的工具」，用户排查一个 run 的 LLM 请求/响应时
 * 不应离开对话页；数据管线（`trace-projection` / `trace-spans` / `trace-context` /
 * run-v2 SSE）原样复用，本组件只做编排：
 *
 * - `ExecutionRibbon`：step-brief（turn / step / llm / tool / 耗时 / 状态）；
 * - `TraceTeamCards`：**仅 Team run** 渲染（单 run 退化为单 root 跨度，不出现编队区）；
 * - `TurnGroupList`：可折叠 turn 分组（默认全部展开，失败 turn 左色条，live 加 "● running"）；
 * - `ContextComposition / ContextTrend / ContextEvents`：同抽屉内的上下文三面板。
 *
 * 归因联动：点击 Team 卡 → 高亮该 agent 的行（`.trace-turn.is-active` + 行级
 * `.is-agent-active`）并滚动到它跨度的首行，**不隐藏其他行**。
 */
import type { RunMetaDtoV2 } from "@aiagent/types";
import { ChevronDown, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../workbench/format";
import { ContextComposition } from "./ContextComposition";
import { ContextEvents } from "./ContextEvents";
import { ContextTrend } from "./ContextTrend";
import { ExecutionRibbon } from "./ExecutionRibbon";
import { runStatusBadgeClass } from "./trace-labels";
import { latestCompositionPoint } from "./trace-context";
import { TraceTeamCards } from "./TraceTeamCards";
import { TurnGroupList } from "./TurnGroup";
import { isTeamRun } from "./trace-spans";
import { useTraceStream } from "./use-trace-stream";

interface TraceDrawerProps {
  /** 当前会话 ID；抽屉数据跟随它（不重复做会话选择）。 */
  conversationId: string | undefined;
  /** 当前会话标题，用于抽屉标题。 */
  conversationTitle: string;
  /** 是否展开：收起时不渲染、也不发请求。 */
  isOpen: boolean;
  /** 收起回调。 */
  onClose: () => void;
}

/**
 * 渲染 Trace 抽屉。
 *
 * @param props 组件属性。
 * @returns 右侧 Trace 面板（收起时返回 null）。
 */
export function TraceDrawer(props: TraceDrawerProps) {
  if (!props.isOpen) return null;
  return (
    <aside aria-label="Trace" className="trace-drawer is-open">
      <header className="trace-drawer-header">
        <div className="trace-drawer-title">
          <p className="md-label">Trace 排查</p>
          <h2>{props.conversationTitle}</h2>
        </div>
        <button className="icon-button" onClick={props.onClose} type="button" aria-label="收起 Trace">
          <X className="icon-size" />
        </button>
      </header>
      <TraceDrawerBody conversationId={props.conversationId} />
    </aside>
  );
}

/**
 * 抽屉内容：数据 hook 只在展开时挂载，收起即卸载并中断 SSE。
 *
 * @param props.conversationId 当前会话 ID。
 * @returns run 选择器、执行地图与上下文三面板。
 */
function TraceDrawerBody(props: { conversationId: string | undefined }) {
  const trace = useTraceStream(props.conversationId, true);
  const [activeAgentId, setActiveAgentId] = useState<string | undefined>(undefined);

  // 切换 run 时清掉上一 run 的高亮：agentId 是 run 内概念，跨 run 复用会让高亮指错人。
  useEffect(() => {
    setActiveAgentId(undefined);
  }, [trace.activeRunId]);

  const latestPoint = useMemo(
    () => latestCompositionPoint(trace.contextPoints),
    [trace.contextPoints]
  );
  const team = isTeamRun(trace.traceSpans);

  /**
   * 点击 Team 卡：高亮 + 滚动到该 agent 跨度的首行。
   *
   * @param agentId 被选中的 agent。
   */
  const selectAgent = useCallback(
    (agentId: string): void => {
      setActiveAgentId((current) => (current === agentId ? undefined : agentId));
      // 滚动在下一帧执行：此时高亮态已提交，目标行的存在性也随之确定。
      window.requestAnimationFrame?.(() => {
        const root = document.querySelector(".trace-drawer-scroll");
        const target = root?.querySelector<HTMLElement>(`[data-agent-key="${cssEscape(agentId)}"]`);
        target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      });
    },
    []
  );

  if (!props.conversationId) {
    return (
      <div className="trace-drawer-body">
        <p className="muted-row">尚未选择会话。选择左侧任一会话后，这里展示它的运行轨迹。</p>
      </div>
    );
  }

  return (
    <div className="trace-drawer-body">
      <div className="trace-drawer-top">
        <RunPicker
          activeRunId={trace.activeRunId}
          onSelectRun={trace.selectRun}
          runs={trace.runs}
          error={trace.error}
        />
        {trace.activeRunMeta ? (
          <div className="trace-drawer-run-meta">
            {/* mode 用中性徽章；CLI 来源在深色玻璃底上改用 info 档（中性徽章与底同色系、
                对比不足，属 v1.4 视觉遗留，本轮只提升语义级别，不引入新配色）。 */}
            <span className="md-badge">{trace.activeRunMeta.mode}</span>
            <span
              className={
                trace.activeRunMeta.source === "cli" ? "md-badge md-badge-info" : "md-badge"
              }
            >
              {trace.activeRunMeta.source === "cli" ? "CLI" : "composer"}
            </span>
            <span>model: {trace.activeRunMeta.modelId}</span>
            <span>requestId: {trace.activeRunMeta.requestId}</span>
            {trace.isLive ? <span className="trace-live-dot" aria-label="live" /> : null}
          </div>
        ) : null}
      </div>
      <div className="trace-drawer-scroll">
        <ExecutionRibbon
          isLive={trace.isLive}
          rows={trace.rows}
          spans={trace.traceSpans}
          status={trace.activeRunMeta?.status}
        />
        {team ? (
          <TraceTeamCards
            activeAgentId={activeAgentId}
            isLive={trace.isLive}
            onSelect={selectAgent}
            spans={trace.traceSpans}
          />
        ) : null}
        <ContextPanels
          entries={trace.contextEventEntries}
          latestPoint={latestPoint}
          points={trace.contextPoints}
        />
        {trace.isLoading && trace.rows.length === 0 ? (
          <p className="muted-row trace-empty">正在回放事件…</p>
        ) : trace.rows.length === 0 && trace.events.length === 0 ? (
          <p className="muted-row trace-empty">
            该 run 暂无事件。CLI 镜像 run 只记录 LLM 请求/响应与 loop 事件，不会写入会话消息。
          </p>
        ) : (
          <TurnGroupList
            activeAgentId={activeAgentId}
            events={trace.events}
            isLive={trace.isLive}
            rows={trace.rows}
          />
        )}
      </div>
      <p className="trace-footnote">
        CLI 会话只镜像 run 事件、不写入对话消息，请在此观测。实时帧为原文；刷新后 replay 经模式级脱敏
        （邮箱 / 手机号显示为 [redacted:*]）。
      </p>
    </div>
  );
}

/**
 * 上下文三面板（折叠区，默认展开）。
 *
 * @param props.points / props.entries / props.latestPoint 三面板数据
 *   （柱列与 ✂ 的 sequence 锚点随 `ContextPoint.sequence` 自带，不再单传一份序列）。
 * @returns 折叠区 + 三面板。
 */
function ContextPanels(props: {
  points: ReturnType<typeof useTraceStream>["contextPoints"];
  entries: ReturnType<typeof useTraceStream>["contextEventEntries"];
  latestPoint: ReturnType<typeof latestCompositionPoint>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <details className="trace-context-fold" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronDown className="icon-size details-chevron" />
        <span className="md-label">Context / Token</span>
      </summary>
      <div className="trace-context-panels">
        <ContextComposition point={props.latestPoint} />
        <ContextTrend entries={props.entries} points={props.points} />
        <ContextEvents entries={props.entries} />
      </div>
    </details>
  );
}

/**
 * 转义 CSS 属性选择器里的字符串值（agentId 可能含引号/反斜杠）。
 *
 * @param value 原始字符串。
 * @returns 可安全放进 `[attr="..."]` 的字符串。
 */
function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Run 选择器：横向排列的 run 摘要按钮（状态徽标 + 相对时间）。
 *
 * @param props.run 列表 / 选中项 / 选择回调 / 错误文案。
 * @returns run 选择条（无 run 时展示空态文案）。
 */
function RunPicker(props: {
  runs: RunMetaDtoV2[];
  activeRunId: string;
  onSelectRun: (runId: string) => void;
  error: string | undefined;
}) {
  if (props.error) return <p className="error-block">{props.error}</p>;
  if (props.runs.length === 0) {
    return <p className="muted-row">本会话还没有运行记录。</p>;
  }
  return (
    <div className="trace-run-picker" role="list" aria-label="Run 列表">
      {props.runs.map((run) => (
        <button
          aria-pressed={run.runId === props.activeRunId}
          className={`trace-run-chip ${run.runId === props.activeRunId ? "is-active" : ""}`}
          key={run.runId}
          onClick={() => props.onSelectRun(run.runId)}
          role="listitem"
          title={run.runId}
          type="button"
        >
          <span className={`md-badge ${runStatusBadgeClass(run.status)}`}>{run.status}</span>
          <span className="trace-run-chip-time">{formatRelativeTime(run.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}
