/**
 * Trace 右侧抽屉（03 D3）：chat 页内的可折叠排查位，数据跟随当前会话。
 *
 * 为什么从独立页降级为抽屉：trace 是「排查问题的工具」，用户排查一个 run 的 LLM 请求/响应时
 * 不应离开对话页；数据管线（`trace-projection` / `trace-client` / run-v2 SSE）原样复用，
 * 仅把三栏编排换成「run 选择器 + 事件流」的单列面板。
 *
 * 本组件只做编排：数据来自 `useTraceStream`，事件行渲染复用 `TraceStream`（`LlmCallBlock`
 * 仍是一等公民，JSON 展开/复制能力不变）。
 */
import type { RunMetaDtoV2 } from "@aiagent/types";
import { X } from "lucide-react";
import { formatRelativeTime } from "../workbench/format";
import { TraceStream } from "./TraceStream";
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
 * @returns run 选择器与事件流。
 */
function TraceDrawerBody(props: { conversationId: string | undefined }) {
  const trace = useTraceStream(props.conversationId, true);

  if (!props.conversationId) {
    return (
      <div className="trace-drawer-body">
        <p className="muted-row">尚未选择会话。选择左侧任一会话后，这里展示它的运行轨迹。</p>
      </div>
    );
  }

  return (
    <div className="trace-drawer-body">
      <RunPicker
        activeRunId={trace.activeRunId}
        onSelectRun={trace.selectRun}
        runs={trace.runs}
        error={trace.error}
      />
      {trace.activeRunMeta ? (
        <div className="trace-drawer-run-meta">
          <span className="md-badge">{trace.activeRunMeta.mode}</span>
          <span className="md-badge">{trace.activeRunMeta.source === "cli" ? "CLI" : "composer"}</span>
          <span>model: {trace.activeRunMeta.modelId}</span>
          <span>requestId: {trace.activeRunMeta.requestId}</span>
        </div>
      ) : null}
      <div className="trace-drawer-scroll">
        <TraceStream isLoading={trace.isLoading} rows={trace.rows} />
      </div>
      <p className="trace-footnote">
        CLI 会话只镜像 run 事件、不写入对话消息，请在此观测。实时帧为原文；刷新后 replay 经模式级脱敏
        （邮箱 / 手机号显示为 [redacted:*]）。
      </p>
    </div>
  );
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

/**
 * 把 run 状态映射到既有徽标配色（不新增视觉语言）。
 *
 * @param status run 状态机值。
 * @returns 徽标 class。
 */
function runStatusBadgeClass(status: string): string {
  if (status === "failed" || status === "interrupted") return "md-badge-danger";
  if (status === "running" || status === "queued") return "md-badge-info";
  return "md-badge-success";
}
