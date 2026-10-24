/**
 * ohna 评测执行器回归测试（run.ts 顺序投影 / judge-rubrics 无关）。
 *
 * 验证关键不变量（防止被其它工作项无意破坏）：
 * 1) loadOhnaDataset 能解析编码数据集且 case 数 ≥ 20；
 * 2) integration 档驱动一条含 read→edit 多步、且 edit 在前声明（声明顺序）的 case，
 *    投影出的轨迹与实际声明顺序严格一致（强制 sequential 装配的回归护栏）；
 * 3) 评测产出的指标至少含四项（fileChangeCorrectness / permissionCompliance /
 *    toolSelectionCorrectness / turnEfficiency），且均在 [0,1]。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOhnaDataset } from "../dist/eval/dataset.js";
import { runOhnaEval } from "../dist/eval/run.js";

const DATASET = new URL("../../../datasets/ohna/coding-v1.json", import.meta.url).pathname;

test("loadOhnaDataset 解析编码数据集且 case 数 ≥ 20", () => {
  const ds = loadOhnaDataset(DATASET);
  assert.ok(ds.cases.length >= 20, `case 数应 ≥ 20，实际 ${ds.cases.length}`);
  assert.equal(typeof ds.datasetVersion, "string");
});

test("含多步读写的 case，投影轨迹与实际声明顺序一致（sequential 装配护栏）", async () => {
  const ds = loadOhnaDataset(DATASET);
  // 选一条「声明顺序含 read 在前、edit 在后」的多步 coding case。
  const case_ = ds.cases.find((c) => c.mode === "coding" && c.expectedToolCalls?.length === 2);
  assert.ok(case_, "应存在多步 coding case");
  const expectedOrder = case_.expectedToolCalls.map((s) => s.tool);

  const report = await runOhnaEval({ ...ds, cases: [case_] }, { tier: "integration" });
  // 单 case 报告中指标分来自该 case 的打分；toolSelectionCorrectness 必须满分
  // （投影轨迹顺序与实际声明一致，否则 parallel 乱序会让此断言失败）。
  const metric = report.metrics.find((m) => m.name === "toolSelectionCorrectness");
  assert.ok(metric, "应产出 toolSelectionCorrectness");
  assert.equal(metric.value, 1, `轨迹顺序应与声明一致，期望 ${JSON.stringify(expectedOrder)}`);
});

test("评测产出四项指标且值在 [0,1]", async () => {
  const ds = loadOhnaDataset(DATASET);
  const report = await runOhnaEval(ds, { tier: "integration" });
  const names = report.metrics.map((m) => m.name);
  for (const required of [
    "fileChangeCorrectness",
    "permissionCompliance",
    "toolSelectionCorrectness",
    "turnEfficiency",
  ]) {
    assert.ok(names.includes(required), `应含指标 ${required}`);
  }
  for (const m of report.metrics) {
    assert.ok(m.value >= 0 && m.value <= 1, `${m.name} 应在 [0,1]，实际 ${m.value}`);
  }
});
