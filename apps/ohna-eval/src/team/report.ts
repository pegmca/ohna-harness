/**
 * team 报告的聚合与门禁投影（从 metrics.ts 拆出，保持单文件职责单一）。
 *
 * 两层语义必须分开：
 * - `aggregateTeamMetrics`：逐 case 得分 → 报告指标（`applicable=false` 不进分母，G5）；
 * - `toHardGateReport`：把趋势指标**机械地**压成不适用，确保它们绝不可能影响 exitCode。
 */

import { roundScore } from "@aiagent/eval-core";
import type { EvalMetricValue, EvalReportDto } from "@aiagent/types";
import { TEAM_METRIC_SPECS, isTrendMetric } from "./specs.js";
import type { TeamMetricName, TeamMetricScore } from "./types.js";

/**
 * 判断单指标是否通过（applicable=false 一律视为「不参与」，恒通过）。
 *
 * @param metric 指标得分。
 * @returns 是否通过。
 */
export function isTeamMetricPassed(metric: TeamMetricScore): boolean {
  if (metric.applicable === false) return true;
  return metric.score >= 1;
}

/**
 * 把逐 case 指标聚合成 `EvalReportDto` 的 metrics 段（G5：appliable=false 不进分母）。
 *
 * @param scoredCases 逐 case 的指标得分列表。
 * @returns 聚合后的指标值列表（按 `TEAM_METRIC_SPECS` 顺序）。
 */
export function aggregateTeamMetrics(scoredCases: readonly TeamMetricScore[][]): EvalMetricValue[] {
  const buckets = new Map<TeamMetricName, number[]>();
  for (const metrics of scoredCases) {
    for (const metric of metrics) {
      if (metric.applicable === false) continue;
      const bucket = buckets.get(metric.name) ?? [];
      bucket.push(metric.score);
      buckets.set(metric.name, bucket);
    }
  }

  return TEAM_METRIC_SPECS.map((spec) => {
    const values = buckets.get(spec.name) ?? [];
    const applicable = values.length > 0;
    const value = applicable ? roundScore(values.reduce((sum, v) => sum + v, 0) / values.length) : 0;
    return { name: spec.name, value, unit: "ratio" as const, applicable };
  });
}

/**
 * 把聚合指标投影成「硬门禁报告」：趋势指标一律置 `applicable=false`。
 *
 * 这是硬/趋势分层的**机械保证**：喂给 `gateReport` 的报告里趋势指标不可适用。
 * eval-core 的 diff 会先过滤两侧的 `applicable === false` 再比较，因此**基线也必须过同一道
 * 投影**（`index.ts` 用本函数同时处理 curr 与 baseline）——否则「基线里残留的趋势指标」
 * 会在当前侧找不到对应项，被记成 missing（current=0）而误判为低于 SLO。
 *
 * @param report 完整报告（当前或基线）。
 * @returns 仅含硬门禁指标可适用性的报告副本。
 */
export function toHardGateReport(report: EvalReportDto): EvalReportDto {
  return {
    ...report,
    metrics: report.metrics.map((metric) =>
      isTrendMetric(metric.name as TeamMetricName) ? { ...metric, applicable: false } : metric,
    ),
  };
}
