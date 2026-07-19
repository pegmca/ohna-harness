#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseline, loadEvalDataset, readBaseline, runAutomationEval, writeBaseline, writeReports } from "./automation.js";

/**
 * 一键 eval CLI；普通运行只读取 baseline，只有 --update-baseline 才能覆盖快照。
 * @returns 进程退出码由回归门禁决定。
 */
async function main(): Promise<void> {
  // CLI 可能由 workspace filter 从 package cwd 启动，因此以编译文件位置稳定定位仓库根目录。
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url))); const datasetPath = resolve(root, "datasets/eval-financial-v1.json"); const baselinePath = resolve(root, "docs/eval/baseline-v1.json");
  const dataset = await loadEvalDataset(datasetPath); const update = process.argv.includes("--update-baseline"); const baseline = await readBaseline(baselinePath);
  const report = runAutomationEval(dataset, update ? undefined : baseline); await writeReports(report, resolve(root, "docs/eval/latest-report.json"), resolve(root, "docs/eval/latest-report.md"));
  if (update) { await writeBaseline(createBaseline(report, dataset), baselinePath); console.log(`baseline updated: ${baselinePath}`); }
  console.log(`eval ${report.results.length} cases, success=${report.metrics.successRate}, regressions=${report.regressionReasons.length}`); process.exitCode = report.regressionReasons.length ? 1 : 0;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
