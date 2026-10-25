/**
 * 执行地图的 step-brief（docs/v2.0/04 §5.5）：turn 数 / step 数 / LLM 调用数 / 工具数 /
 * 总耗时 / 状态徽标。
 *
 * 数据全部从投影行与跨度推导（纯展示，不订阅事件流）：Ribbon 是「这一趟跑了多少」的一行答案，
 * 详细排查仍然落在下面的 TurnGroup。视觉复用既有 `.trace-summary-grid` + `.md-badge` +
 * `runStatusBadgeClass`，不新增视觉语言。
 */
import type { RunStatusDtoV2 } from "@aiagent/types";
import { formatDuration, formatNumber } from "./trace-labels";
import type { TraceRow } from "./trace-projection";
import type { TraceSpans } from "./trace-spans";

/** Ribbon 的属性。 */
export interface ExecutionRibbonProps {
  /** 投影行（统计 step / 工具 / LLM 调用数）。 */
  rows: TraceRow[];
  /** 跨度集合（统计 turn 数与总耗时）。 */
  spans: TraceSpans;
  /** run 状态机值（徽标）。 */
  status: RunStatusDtoV2 | undefined;
  /** 是否仍在运行（决定状态文案是否为 live）。 */
  isLive: boolean;
}

/** step-brief 的派生数字（纯函数，便于单测）。 */
export interface ExecutionBrief {
  /** 已出现的 turn 数（按 (agentId, turnIndex) 键去重，排除无 turn_start 的 -1 槽位）。 */
  turns: number;
  /** 事件行数（message / tool / llm / terminal / context 全部计入）。 */
  steps: number;
  /** LLM 调用次数。 */
  llmCalls: number;
  /** 工具调用次数。 */
  tools: number;
  /** 总耗时：所有 LLM 调用 durationMs 之和（未拿到耗时的那次按 0 计）。 */
  durationMs: number;
}

/**
 * 从行与跨度算出 step-brief 数字。
 *
 * 总耗时为什么用「LLM 调用耗时之和」而不是墙钟时间：事件流不带 run 起止时间戳，
 * 用 startedAt 相减会在重放/续传时失真；而每次调用的 durationMs 是采集层实测值，
 * 口径稳定且可解释（标注为「其中 LLM 耗时」）。
 *
 * @param rows 投影行。
 * @param spans 跨度集合。
 * @returns 摘要数字。
 */
export function summarizeExecution(rows: readonly TraceRow[], spans: TraceSpans): ExecutionBrief {
  let llmCalls = 0;
  let tools = 0;
  let durationMs = 0;
  for (const row of rows) {
    if (row.kind === "llm") {
      llmCalls += 1;
      durationMs += row.record.durationMs ?? 0;
    } else if (row.kind === "tool") {
      tools += 1;
    }
  }
  const turns = spans.turns.filter((turn) => turn.turnIndex >= 0).length;
  return { turns, steps: rows.length, llmCalls, tools, durationMs };
}

/**
 * 渲染执行摘要条。
 *
 * @param props 见 `ExecutionRibbonProps`。
 * @returns 六格摘要 + 状态徽标。
 */
export function ExecutionRibbon(props: ExecutionRibbonProps) {
  const brief = summarizeExecution(props.rows, props.spans);
  const status = props.status ?? "unknown";
  return (
    <section aria-label="执行摘要" className="trace-ribbon">
      <p className="md-label">Execution</p>
      <div className="trace-summary-grid">
        <span>
          <small>turns</small>
          <strong>{formatNumber(brief.turns)}</strong>
        </span>
        <span>
          <small>steps</small>
          <strong>{formatNumber(brief.steps)}</strong>
        </span>
        <span>
          <small>llm calls</small>
          <strong>{formatNumber(brief.llmCalls)}</strong>
        </span>
        <span>
          <small>tools</small>
          <strong>{formatNumber(brief.tools)}</strong>
        </span>
        <span>
          <small>总耗时（LLM 累计）</small>
          <strong>{formatDuration(brief.durationMs)}</strong>
        </span>
        <span>
          <small>status</small>
          <strong className="trace-ribbon-status">{props.isLive ? "● running" : status}</strong>
        </span>
      </div>
    </section>
  );
}
