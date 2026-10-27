/**
 * Context Events 面板（docs/v2.0/04 §5.5）：`buildContextEvents` 的日志。
 *
 * v2.0 只有 compaction 一种 kind（prune / inject / mode / model_switch 对应的运行时动作
 * 还不存在，见 04 §9）。每个 chip 展示压缩前后的 token 与**净增量**，说明字段来自
 * serve 的 payload（摘要长度、保留轮数等），因此用户能解释「窗口为什么突然变小」。
 *
 * 与 Trend 的 ✂ 同源（都读 `context_event`），渲染位置不同：这里是日志，Trend 是定位标记。
 */
import { History, Scissors } from "lucide-react";
import {
  CONTEXT_ESTIMATE_LABEL,
  CONTEXT_ESTIMATE_NOTE,
  formatDelta,
  formatNumber
} from "./trace-labels";
import { contextEventDelta, type ContextEventEntry } from "./trace-context";

/** 面板属性。 */
export interface ContextEventsProps {
  /** 上下文事件条目（事件顺序）。 */
  entries: ContextEventEntry[];
}

/**
 * 渲染上下文事件日志。
 *
 * @param props 见 `ContextEventsProps`。
 * @returns chip 列表（空态给一句可解释的提示）+ 共享口径脚注。
 */
export function ContextEvents(props: ContextEventsProps) {
  return (
    <section aria-label="Context Events" className="trace-panel md-glass">
      <header className="trace-panel-head">
        <p className="md-label">
          <History className="icon-size" aria-hidden /> Context Events
        </p>
        <span className="trace-panel-note">
          {CONTEXT_ESTIMATE_LABEL} · {props.entries.length} 条
        </span>
      </header>
      {props.entries.length === 0 ? (
        <p className="muted-row">本次 run 未发生上下文结构变化（没有触发 compaction）。</p>
      ) : (
        <ul className="trace-event-list">
          {props.entries.map((entry) => {
            const delta = contextEventDelta(entry.payload);
            return (
              <li key={entry.eventId}>
                <div className="trace-event-chip" data-context-mark={entry.payload.kind}>
                  <Scissors className="icon-size" aria-hidden />
                  <span className="md-badge md-badge-info">{entry.payload.kind}</span>
                  <span className="trace-event-delta">{formatDelta(delta.delta)} tokens</span>
                  <span className="trace-event-range">
                    {formatNumber(delta.before)} → {formatNumber(delta.after)}
                  </span>
                </div>
                {entry.payload.detail ? (
                  <p className="trace-event-detail">{entry.payload.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="trace-footnote">{CONTEXT_ESTIMATE_NOTE}</p>
    </section>
  );
}
