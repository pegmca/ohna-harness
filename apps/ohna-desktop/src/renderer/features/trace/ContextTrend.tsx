/**
 * Context Trend 面板（docs/v2.0/04 §5.5）：每次 LLM 请求一根堆叠条，按 `callIndex` 横排。
 *
 * 为什么每根柱子又纵切分段：横向看是「这一次请求占了多少窗口」，纵向对比是「窗口占比
 * 随时间怎么变」；`context_event` 的 ✂（compaction）标记钉在对应位置，柱子高度骤降
 * 因此自解释——不是渲染 bug，是压缩回收了上下文。
 *
 * ✂ 的位置由 `compactionColumnIndex` 按事件 sequence 计算：run 前的 compaction 早于任何
 * `llm_call`，因此它钉在第一根柱子之前。
 *
 * 两类高度必须分开读：
 * - **柱高**（`.trace-trend-fill`）＝本次估算总量 ÷ 满窗，表达「这一次请求占了多大窗口」；
 * - **柱内色槽**（`.trace-trend-seg`）＝各分类在**本次总量内**的占比，表达「构成怎么变」。
 * 因此单段色槽的像素高度是「总量比例 × 分类占比」的乘积，小分类在高柱里会被压到亚像素；
 * 精确数字以 `title`（总量/满窗）与图例脚注为准，色槽只承担构成变化的视觉信号。
 */
import { Scissors, TrendingUp } from "lucide-react";
import { Fragment } from "react";
import {
  COMPOSITION_SEGMENTS,
  CONTEXT_ESTIMATE_LABEL,
  CONTEXT_ESTIMATE_NOTE,
  compositionValue,
  formatDelta,
  formatNumber,
  tokenPercent
} from "./trace-labels";
import {
  compactionColumnIndex,
  contextEventDelta,
  type ContextEventEntry,
  type ContextPoint,
  type ContextTrendColumn
} from "./trace-context";

/** 柱子高度（px）：显式高度保证「百分比填充」在滚动容器里也能正确换算。 */
const TREND_BAR_HEIGHT = 96;

/** 面板属性。 */
export interface ContextTrendProps {
  /** 每次 LLM 请求的上下文点（事件顺序；每点自带 `sequence`，✂ 定位就靠它）。 */
  points: ContextPoint[];
  /** 上下文事件条目（compaction 标记）。 */
  entries: ContextEventEntry[];
}

/**
 * 把上下文点投影成柱序列（✂ 的定位锚点取自点自身的 `sequence`）。
 *
 * 为什么不再接受「另传一份 llm_call sequence 数组」：那是两条独立推导（投影层按
 * `request/window` 完整性过滤、消费方按 `type === "llm_call"` 过滤），口径一旦不一致就
 * 会整体错位——例如一条坏记录被投影层跳过，后续每根柱子都会挂到上一条记录的 sequence 上，
 * ✂ 因此钉错位置。让点在投影时自带 sequence，配对只剩恒等映射，不变量由类型保证。
 *
 * @param points 上下文点。
 * @returns 柱序列（与 points 等长同序）。
 */
export function toTrendColumns(points: readonly ContextPoint[]): ContextTrendColumn[] {
  return points.map((point) => ({ point, sequence: point.sequence }));
}

/**
 * 渲染窗口成长曲线。
 *
 * @param props 见 `ContextTrendProps`。
 * @returns 柱状趋势 + compaction 标记 + 共享口径脚注。
 */
export function ContextTrend(props: ContextTrendProps) {
  const columns = toTrendColumns(props.points);
  if (columns.length === 0) {
    return (
      <section aria-label="Context Trend" className="trace-panel md-glass">
        <header className="trace-panel-head">
          <p className="md-label">
            <TrendingUp className="icon-size" aria-hidden /> Context Trend
          </p>
          <span className="trace-panel-note">{CONTEXT_ESTIMATE_LABEL}</span>
        </header>
        <p className="muted-row">该 run 还没有 LLM 调用记录。</p>
        <p className="trace-footnote">{CONTEXT_ESTIMATE_NOTE}</p>
      </section>
    );
  }

  // ✂ 的位置口径（与「钉在柱前」的措辞一致）：标记插在「sequence 严格大于它」的第一根柱子**之前**。
  // 因此它排在索引 i 之前 = DOM 上的「第 i 根柱（0 起）之前」，即紧随第 i-1 根柱之后。
  // 首根柱之前的位置另由 `compactionColumnIndex === 0` 表达，两者不冲突：
  // 早于所有调用的 compaction（run 前压缩）插在最前面，落在两次调用之间的插在前一根柱之后。
  /** 插在某一柱列（按 DOM 顺序）之前的 ✂。 */
  const marksBefore = new Map<number, ContextEventEntry[]>();
  /** 晚于所有柱列的 ✂（理论上只在「有 context_event 但没有任何 llm_call」时出现）。 */
  const marksAfter: ContextEventEntry[] = [];
  for (const entry of props.entries) {
    const index = compactionColumnIndex(columns, entry.sequence);
    if (index >= columns.length) {
      marksAfter.push(entry);
      continue;
    }
    marksBefore.set(index, [...(marksBefore.get(index) ?? []), entry]);
  }

  return (
    <section aria-label="Context Trend" className="trace-panel md-glass">
      <header className="trace-panel-head">
        <p className="md-label">
          <TrendingUp className="icon-size" aria-hidden /> Context Trend
        </p>
        <span className="trace-panel-note">
          {CONTEXT_ESTIMATE_LABEL} · {columns.length} 次请求
        </span>
      </header>
      <div className="trace-trend" role="img" aria-label="每次 LLM 请求的窗口占用">
        {columns.map((column, index) => {
          const window = column.point.window.contextWindow;
          const total = column.point.composition?.total ?? column.point.actual.input;
          const usedPercent = Math.min(100, tokenPercent(total, window));
          const marks = marksBefore.get(index) ?? [];
          return (
            <Fragment key={`${column.sequence}-${index}`}>
              {marks.map((entry) => (
                <CompactionMark entry={entry} key={`${entry.eventId}-before`} />
              ))}
              <div
                className="trace-trend-col"
                data-agent-key={column.point.agentId ?? "supervisor"}
                title={`#${column.point.callIndex} · ${formatNumber(total)} / ${formatNumber(window)}（${usedPercent.toFixed(1)}%）`}
              >
                <div className="trace-trend-bar" style={{ height: `${TREND_BAR_HEIGHT}px` }}>
                  <span
                    className="trace-trend-fill"
                    style={{ height: `${usedPercent}%` }}
                    aria-hidden
                  >
                    {COMPOSITION_SEGMENTS.map((segment) => {
                      const value = column.point.composition
                        ? compositionValue(column.point.composition, segment.key)
                        : 0;
                      const share = total > 0 ? (value / total) * 100 : 0;
                      return (
                        <span
                          className={`trace-trend-seg seg-${segment.key}`}
                          key={segment.key}
                          style={{ height: `${share}%` }}
                        />
                      );
                    })}
                  </span>
                </div>
                <span className="trace-trend-index">#{column.point.callIndex}</span>
                {column.point.agentId && column.point.agentId !== "supervisor" ? (
                  <span className="trace-trend-agent">{column.point.agentId}</span>
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {marksAfter.map((entry) => (
          <CompactionMark entry={entry} key={`${entry.eventId}-after`} />
        ))}
      </div>
      <p className="trace-footnote">{CONTEXT_ESTIMATE_NOTE}</p>
    </section>
  );
}

/**
 * 柱列之间的 ✂ 标记（compaction）。
 *
 * @param props.entry 上下文事件条目。
 * @returns 标记元素。
 */
function CompactionMark(props: { entry: ContextEventEntry }) {
  const delta = contextEventDelta(props.entry.payload);
  return (
    <div
      aria-label="compaction 压缩"
      className="trace-trend-mark"
      data-context-mark="compaction"
      title={props.entry.payload.detail ?? "run 前会话级压缩"}
    >
      <Scissors className="icon-size" aria-hidden />
      <span className="trace-trend-mark-delta">{formatDelta(delta.delta)}</span>
    </div>
  );
}
