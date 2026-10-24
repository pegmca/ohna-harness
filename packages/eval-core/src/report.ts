/**
 * 评测报告渲染与落盘（v2.0 薄内核方案 §2.2）：
 *
 * 仅依赖 `EvalReportDto` 线格式与 `BaselineDiff`，把报告渲染为 Markdown 并落盘为
 * `report.json` / `report.md`。纯函数 + 一处 IO（写文件），零 app / 指标类型依赖。
 */

import { mkdir, writeFile } from "node:fs/promises";
import type { BaselineDiff, EvalReportDto } from "@aiagent/types";

/** 把数值格式化为可读字符串（ratio 保留四位，其余至多两位）。 */
function formatValue(value: number, unit?: string): string {
  if (unit === "ratio") return value.toFixed(4);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 仅保留参与聚合 / 报告的指标（过滤 `applicable === false`）。 */
function applicableMetrics(report: EvalReportDto): EvalReportDto["metrics"] {
  return report.metrics.filter((metric) => metric.applicable !== false);
}

/**
 * 把评测报告渲染为 Markdown。
 *
 * 渲染口径：
 * - 顶部元信息（target / dataset / createdAt / 通过率）；
 * - 仅 `applicable` 的指标进入指标表（G5 修复）；
 * - baseline diff 表（若传入非空 diff）；
 * - 失败 case 归因（failedMetrics / failedTaxonomy）。
 *
 * @param report 评测报告线格式。
 * @param diff 相对 baseline 的 diff（可选，通常来自 `diffBaseline`）。
 * @returns Markdown 文本。
 */
export function renderMarkdown(report: EvalReportDto, diff: BaselineDiff[]): string {
  const lines: string[] = [];
  const metrics = applicableMetrics(report);

  const passedCases = report.cases.filter((item) => item.passed).length;
  const passRate = report.cases.length > 0 ? passedCases / report.cases.length : 0;

  lines.push(`# 评测报告 ${report.target} / ${report.dataset}`);
  lines.push("");
  lines.push(`- 生成时间：${report.createdAt}`);
  lines.push(`- 用例数：${report.cases.length}`);
  lines.push(`- 通过率：${(passRate * 100).toFixed(1)}% (${passedCases}/${report.cases.length})`);
  if (report.summary) {
    lines.push("");
    lines.push(report.summary);
  }
  lines.push("");

  lines.push(`## 指标（仅 applicable 计入，${metrics.length}/${report.metrics.length}）`);
  lines.push("");
  if (metrics.length === 0) {
    lines.push("_无 applicable 指标。_");
  } else {
    lines.push("| 指标 | 值 | 单位 |");
    lines.push("| --- | --- | --- |");
    for (const metric of metrics) {
      lines.push(`| ${metric.name} | ${formatValue(metric.value, metric.unit)} | ${metric.unit ?? "—"} |`);
    }
  }
  lines.push("");

  if (diff.length > 0) {
    lines.push("## Baseline Diff");
    lines.push("");
    lines.push("| 指标 | 当前 | 基线 | Δ | 状态 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of diff) {
      lines.push(
        `| ${item.metric} | ${formatValue(item.current)} | ${formatValue(item.baseline)} | ${item.delta.toFixed(4)} | ${item.status} |`,
      );
    }
    lines.push("");
  }

  const failed = report.cases.filter((item) => !item.passed);
  if (failed.length > 0) {
    lines.push("## 失败 Case 归因");
    lines.push("");
    lines.push("| case | 失败指标 | 分类 |");
    lines.push("| --- | --- | --- |");
    for (const item of failed) {
      const metricsText = (item.failedMetrics ?? []).join(", ") || "—";
      lines.push(`| ${item.id} | ${metricsText} | ${item.failedTaxonomy ?? "—"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 把报告与 diff 落盘到指定目录（生成 `report.json` 与 `report.md`）。
 *
 * 目录不存在时自动创建。写盘失败向上抛出，由调用方决定重试 / 中止。
 *
 * @param report 评测报告线格式。
 * @param outDir 输出目录（绝对或相对均可）。
 * @returns 落盘完成后的目录路径。
 */
export async function writeReports(report: EvalReportDto, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const md = renderMarkdown(report, []);
  await Promise.all([
    writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2), "utf8"),
    writeFile(`${outDir}/report.md`, md, "utf8"),
  ]);
}
