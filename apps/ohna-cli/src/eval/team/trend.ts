/**
 * team 趋势门禁（docs/v2.0/03-team-eval.md §5.1 / §8 的第二层）。
 *
 * ## 与硬门禁的机械分层
 *
 * - **硬门禁**（`index.ts` → eval-core `gateReport`）只吃 `toHardGateReport()` 产出的报告：
 *   趋势指标在该报告里被置为 `applicable:false`，即使误把趋势指标写进 SLO 也判不动；
 * - **趋势门禁**（本文件）产出一份独立 markdown + `trend.json`，**永不参与 exitCode**。
 *
 * 这份分层的价值：`dispatchCorrectness`（spawn 谁 / 派给谁）与 `costAmplificationRatio`
 * 只能靠真模型统计得出（§7「T-L4」），把它们做成 block 会让 CI 因模型波动随机失败；
 * 而 `costAmplificationRatio` 更明确「模型变便宜会导致放大比升高被误判回归」（§7 末尾），
 * 只作 soft/warn。
 */

import { diffBaseline, roundScore } from "@aiagent/eval-core";
import type { BaselineDiff, EvalReportDto } from "@aiagent/types";
import { COST_AMPLIFICATION_WARN_RATIO, TREND_METRICS } from "./metrics.js";
import type { TeamCaseRun } from "./run-type.js";
import type { TeamMetricName } from "./types.js";

/** 趋势段的单指标行。 */
export interface TrendMetricRow {
  /** 指标名。 */
  metric: TeamMetricName;
  /** 本次值（[0,1] 归一化）；无证据时为 null。 */
  current: number | null;
  /** 基线值；无基线或基线无该指标时为 null。 */
  baseline: number | null;
  /** 相对基线的 delta；任一侧缺失时为 null。 */
  delta: number | null;
  /** 是否触发 soft/warn（只告警，不 block）。 */
  warn: boolean;
  /** 人类可读的说明（含证据计数与阈值）。 */
  note: string;
}

/** 趋势段完整产出。 */
export interface TeamTrendSection {
  /** 是否已产出有效趋势（无凭据 / 无执行 case 时为 false 并带 skip 原因）。 */
  applicable: boolean;
  /** 未产出趋势的原因（禁止静默：无凭据必须写明）。 */
  skipReason?: string;
  /** 逐指标行。 */
  rows: TrendMetricRow[];
  /** 渲染好的 markdown 段。 */
  markdown: string;
}

/** `buildTeamTrend` 的入参。 */
export interface BuildTeamTrendOptions {
  /** 本次逐 case 执行结果。 */
  runs: readonly TeamCaseRun[];
  /** 本次完整报告（趋势指标按聚合值读取）。 */
  report: EvalReportDto;
  /** 基线报告（可为 null：首次跑）。 */
  baseline: EvalReportDto | null;
  /** 档位标识（写进 markdown 标题）。 */
  tier: string;
}

/** 取报告中某指标的聚合值（找不到返回 null）。 */
function metricValue(report: EvalReportDto | null, name: TeamMetricName): number | null {
  if (!report) return null;
  const metric = report.metrics.find((item) => item.name === name);
  if (!metric || metric.applicable === false) return null;
  return metric.value;
}

/** 在 diff 列表里取某指标（找不到返回 undefined）。 */
function diffOf(diffs: readonly BaselineDiff[], name: TeamMetricName): BaselineDiff | undefined {
  return diffs.find((item) => item.metric === name);
}

/**
 * 把趋势行渲染成 markdown（独立段落，供 report.md 追加）。
 *
 * @param rows 趋势行。
 * @param tier 档位标识。
 * @param skipReason 未产出趋势的原因（有值时不渲染表格，直接写明跳过原因）。
 * @returns markdown 文本。
 */
function renderTrendMarkdown(rows: readonly TrendMetricRow[], tier: string, skipReason?: string): string {
  const lines = [`## 趋势门禁（${tier}，不 block）`, ""];
  if (skipReason) {
    lines.push(`> ${skipReason}`);
    return lines.join("\n");
  }
  lines.push("| 指标 | 本次 | 基线 | Δ | 告警 | 说明 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const fmt = (value: number | null): string => (value === null ? "—" : value.toFixed(4));
    lines.push(
      `| ${row.metric} | ${fmt(row.current)} | ${fmt(row.baseline)} | ${fmt(row.delta)} | ${row.warn ? "⚠ warn" : "ok"} | ${row.note} |`,
    );
  }
  lines.push("");
  lines.push(
    `> 趋势指标永不参与 exitCode（§8）；\`${"teamCostAmplificationRatio"}\` 仅作 soft/warn，warn 阈值 ${COST_AMPLIFICATION_WARN_RATIO}×。`,
  );
  return lines.join("\n");
}

/**
 * 汇总趋势段（§8「趋势门禁」）。
 *
 * 产出规则：
 * - 无任何 case 被真正执行（如 T-L2b/T-L4 无 provider 凭据）→ `applicable:false` +
 *   显式 skip 原因，不渲染假数据；
 * - 有执行 → 逐趋势指标给出「本次 / 基线 / Δ / 是否 warn」，`dispatchCorrectness` 低于 1
 *   只告警；`costAmplificationRatio` 超阈值只告警。
 *
 * @param options runs / report / baseline / tier。
 * @returns 趋势段产出（含 markdown）。
 */
export function buildTeamTrend(options: BuildTeamTrendOptions): TeamTrendSection {
  const executed = options.runs.filter((run) => run.executed);
  if (executed.length === 0) {
    const skipReason = options.runs[0]?.skipReason ?? "本档位没有真正执行的 case，未产出趋势数据";
    return {
      applicable: false,
      skipReason,
      rows: [],
      markdown: renderTrendMarkdown([], options.tier, skipReason),
    };
  }

  const diffs = options.baseline ? diffBaseline(options.report, options.baseline) : [];
  const rows: TrendMetricRow[] = TREND_METRICS.map((name) => {
    const current = metricValue(options.report, name);
    const baseline = metricValue(options.baseline, name);
    const diff = diffOf(diffs, name);
    const delta = current !== null && baseline !== null ? roundScore(current - baseline) : null;

    // 告警口径：成本放大比看阈值，其余趋势指标看「是否低于基线」。
    const warn =
      current === null
        ? false
        : name === "teamCostAmplificationRatio"
          ? current < 1 // 归一化得分 < 1 表示放大比超过 warn 阈值
          : baseline !== null && current < baseline;

    const note = describeTrendRow(name, current, baseline, options.runs);
    return { metric: name, current, baseline, delta, warn, note: note + (diff ? `；${diff.status}` : "") };
  });

  return { applicable: true, rows, markdown: renderTrendMarkdown(rows, options.tier) };
}

/**
 * 生成趋势行说明文本（证据计数 + 阈值语义）。
 *
 * @param name 指标名。
 * @param current 本次值。
 * @param baseline 基线值。
 * @param runs 逐 case 结果（用于计数）。
 * @returns 说明文本。
 */
function describeTrendRow(
  name: TeamMetricName,
  current: number | null,
  baseline: number | null,
  runs: readonly TeamCaseRun[],
): string {
  const executed = runs.filter((run) => run.executed);
  const applicableCases = executed.filter((run) =>
    run.metrics.some((metric) => metric.name === name && metric.applicable !== false),
  ).length;
  if (current === null) {
    return `${applicableCases}/${executed.length} case 覆盖，无适用证据`;
  }
  if (name === "teamCostAmplificationRatio") {
    return `${applicableCases}/${executed.length} case 覆盖；仅 soft/warn，永不 block`;
  }
  if (baseline === null) {
    return `${applicableCases}/${executed.length} case 覆盖；无基线（首次跑）`;
  }
  return `${applicableCases}/${executed.length} case 覆盖；基线 ${baseline.toFixed(4)}`;
}

/**
 * 把趋势段追加到 report.md 文本末尾（纯字符串操作，便于单测）。
 *
 * @param markdown 原 report.md 内容。
 * @param trend 趋势段。
 * @returns 追加后的文本。
 */
export function appendTrendSection(markdown: string, trend: TeamTrendSection): string {
  return `${markdown.replace(/\s*$/, "")}\n\n${trend.markdown}\n`;
}
