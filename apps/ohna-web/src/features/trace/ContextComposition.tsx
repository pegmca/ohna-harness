/**
 * Current Context 面板（docs/v2.0/04 §5.5）：五分类堆叠条，对照 `window.contextWindow`。
 *
 * 结构：一条 100% = 满窗的横条，内部依次是五类估算段（system / tools / user / assistant /
 * toolResult），尾部两段**斜纹掩码**分别是压缩预留（reserveTokens）与输出预算（maxTokens）。
 * 掩码为什么用 hatch 而不是第三种颜色：这两段不是「已占用的上下文」，而是「不可用于历史
 * 消息的窗口」，斜纹在视觉上表达「预留/不可用」，并且复用既有 token 不新增配色。
 *
 * 数据源：最近一次带 composition 的 `llm_call`（`latestCompositionPoint`），不重新估算。
 * 脚注与 Trend / Events 共用 `CONTEXT_ESTIMATE_NOTE`（只写一份）。
 */
import { Layers } from "lucide-react";
import {
  COMPOSITION_SEGMENTS,
  CONTEXT_ESTIMATE_LABEL,
  CONTEXT_ESTIMATE_NOTE,
  compositionValue,
  formatNumber,
  tokenPercent
} from "./trace-labels";
import type { ContextPoint } from "./trace-context";

/** 堆叠条高度（px）：显式高度而非百分比，父容器（滚动区）高度不确定时也能正确换算分段比例。 */
const STACK_BAR_HEIGHT = 140;

/** 一段堆叠条（分类段或掩码段）。 */
export interface SegmentLayout {
  /** 槽名（分类键或 `reserve` / `output`）。 */
  key: string;
  /** 显示文案。 */
  label: string;
  /** token 数。 */
  tokens: number;
  /** 占满窗的百分比（截断到 100，避免超窗时溢出容器）。 */
  percent: number;
  /** 是否斜纹掩码段。 */
  hatch: boolean;
}

/**
 * 计算堆叠条的分段布局（纯函数，便于单测比例）。
 *
 * 五分类按顺序累加，累计到 100% 即停止追加（超窗部分用图例里的真实数字体现）；
 * 掩码段始终跟在分类段之后，同样按满窗比例换算。
 *
 * @param point 最近一次上下文点（必须带 composition）。
 * @returns 分段数组（含两段掩码），以及「五分类合计占满窗的百分比」。
 */
export function layoutComposition(point: ContextPoint): { segments: SegmentLayout[]; usedPercent: number } {
  const composition = point.composition;
  const window = point.window;
  const total = window.contextWindow;
  const segments: SegmentLayout[] = [];
  let cursor = 0;
  let used = 0;
  for (const segment of COMPOSITION_SEGMENTS) {
    const tokens = composition ? compositionValue(composition, segment.key) : 0;
    used += tokens;
    const raw = tokenPercent(tokens, total);
    // 从当前游标起最多画到 100%，其余部分交给图例的真实数字（不静默吞掉超窗信息）。
    const percent = Math.max(0, Math.min(100 - cursor, raw));
    cursor += percent;
    segments.push({ key: segment.key, label: segment.label, tokens, percent, hatch: false });
  }
  const masks: Array<{ key: string; label: string; tokens: number }> = [
    { key: "reserve", label: "压缩预留 reserveTokens", tokens: window.reserveTokens },
    { key: "output", label: "输出预算 maxTokens", tokens: window.maxTokens }
  ];
  for (const mask of masks) {
    const raw = tokenPercent(mask.tokens, total);
    const percent = Math.max(0, Math.min(100 - cursor, raw));
    cursor += percent;
    segments.push({ ...mask, percent, hatch: true });
  }
  return { segments, usedPercent: tokenPercent(used, total) };
}

/** 面板属性。 */
export interface ContextCompositionProps {
  /** 最近一次带 composition 的上下文点；undefined 表示还没有可用快照。 */
  point: ContextPoint | undefined;
}

/**
 * 渲染 Current Context 面板。
 *
 * @param props.point 最近一次上下文点。
 * @returns 堆叠条 + 图例 + 共享口径脚注。
 */
export function ContextComposition(props: ContextCompositionProps) {
  const point = props.point;
  if (!point || !point.composition) {
    return (
      <section aria-label="Current Context" className="trace-panel md-glass">
        <header className="trace-panel-head">
          <p className="md-label">
            <Layers className="icon-size" aria-hidden /> Current Context
          </p>
          <span className="trace-panel-note">{CONTEXT_ESTIMATE_LABEL}</span>
        </header>
        <p className="muted-row">尚无带窗口构成的 LLM 调用（请求未到达 payload 阶段）。</p>
        <p className="trace-footnote">{CONTEXT_ESTIMATE_NOTE}</p>
      </section>
    );
  }

  const layout = layoutComposition(point);
  const total = point.window.contextWindow;
  return (
    <section aria-label="Current Context" className="trace-panel md-glass">
      <header className="trace-panel-head">
        <p className="md-label">
          <Layers className="icon-size" aria-hidden /> Current Context
        </p>
        <span className="trace-panel-note">
          #{point.callIndex} · 窗口 {formatNumber(total)}
        </span>
      </header>
      <div
        aria-label="上下文窗口构成"
        className="trace-stack-bar is-vertical"
        role="img"
        style={{ height: `${STACK_BAR_HEIGHT}px` }}
        title={`已用 ${formatNumber(point.composition.total)} / ${formatNumber(total)}`}
      >
        {layout.segments.map((segment) => (
          <span
            className={`trace-stack-seg seg-${segment.key} ${segment.hatch ? "is-hatch" : ""}`}
            data-percent={segment.percent.toFixed(2)}
            key={segment.key}
            style={{ height: `${segment.percent}%` }}
            title={`${segment.label}：${formatNumber(segment.tokens)} tokens`}
          />
        ))}
      </div>
      <ul className="trace-legend">
        {layout.segments.map((segment) => (
          <li className={segment.hatch ? "is-hatch" : ""} key={segment.key}>
            <span className={`trace-legend-swatch seg-${segment.key} ${segment.hatch ? "is-hatch" : ""}`} />
            <span className="trace-legend-label">{segment.label}</span>
            <span className="trace-legend-value">
              {formatNumber(segment.tokens)} · {segment.percent.toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="trace-panel-note">
        已用 {formatNumber(point.composition.total)} / {formatNumber(total)}（{layout.usedPercent.toFixed(1)}%）
      </p>
      <p className="trace-footnote">{CONTEXT_ESTIMATE_NOTE}</p>
    </section>
  );
}
