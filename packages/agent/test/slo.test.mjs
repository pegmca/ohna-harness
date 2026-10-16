import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSlo } from "../dist/team/slo.js";

/** 构造一条 SLO 样本（省略可选容量字段，默认 undefined）。 */
function slo(durationMs, outcome = "completed", totalCost = 0.01, turnCount = 1) {
  return { durationMs, outcome, totalCost, turnCount };
}

test("summarizeSlo：已知 duration 数组的 p50/p95/avg/successRate 正确", () => {
  // durations: 10,20,30,40,50 → 升序；p50 取 floor(0.5*4)=2 → 30；p95 取 floor(0.95*4)=3 → 40。
  const runs = [
    slo(10, "completed", 0.01, 1),
    slo(20, "completed", 0.02, 2),
    slo(30, "completed", 0.03, 1),
    slo(40, "failed", 0.04, 3),
    slo(50, "completed", 0.05, 2),
  ];
  const agg = summarizeSlo(runs);
  assert.equal(agg.count, 5);
  assert.equal(agg.successRate, 4 / 5);
  assert.equal(agg.p50DurationMs, 30);
  assert.equal(agg.p95DurationMs, 40);
  assert.equal(agg.avgDurationMs, (10 + 20 + 30 + 40 + 50) / 5);
  assert.ok(Math.abs(agg.avgCost - (0.01 + 0.02 + 0.03 + 0.04 + 0.05) / 5) < 1e-12);
  assert.equal(agg.avgTurnCount, (1 + 2 + 1 + 3 + 2) / 5);
  // 全样本无容量字段 → 容量聚合为 undefined（不误报 0）。
  assert.equal(agg.maxActiveRuns, undefined);
  assert.equal(agg.maxPeakConcurrency, undefined);
});

test("summarizeSlo：空数组返回全 0 零值聚合，不抛错", () => {
  const agg = summarizeSlo([]);
  assert.equal(agg.count, 0);
  assert.equal(agg.successRate, 0);
  assert.equal(agg.p50DurationMs, 0);
  assert.equal(agg.p95DurationMs, 0);
  assert.equal(agg.avgDurationMs, 0);
  assert.equal(agg.avgCost, 0);
  assert.equal(agg.avgTurnCount, 0);
  assert.equal(agg.maxActiveRuns, undefined);
  assert.equal(agg.maxPeakConcurrency, undefined);
});

test("summarizeSlo：非有限值被忽略（视为 0），容量峰值取最大值", () => {
  const runs = [
    slo(Number.NaN, "completed", 0.01, 1),
    slo(Infinity, "completed", 0.02, 2),
    slo(25, "completed", 0.03, 1),
    // 仅这两条带有效容量观测：activeRuns 与 peakConcurrency 取 max。
    { durationMs: 15, outcome: "completed", totalCost: 0.04, turnCount: 1, activeRuns: 4, peakConcurrency: 7 },
    { durationMs: 35, outcome: "completed", totalCost: 0.05, turnCount: 1, activeRuns: 2, peakConcurrency: 5 },
  ];
  const agg = summarizeSlo(runs);
  // duration 全部非有限 → 按 0 处理，仅 25/15/35 三个有限值参与（NaN/Infinity 视为 0 混入排序）。
  // 排序后 [0,0,15,25,35]：p50=floor(0.5*4)=2 → 15；p95=floor(0.95*4)=3 → 25；avg=(0+0+15+25+35)/5=15。
  assert.equal(agg.p50DurationMs, 15);
  assert.equal(agg.p95DurationMs, 25);
  assert.equal(agg.avgDurationMs, 15);
  // 容量峰值取有限观测的最大值。
  assert.equal(agg.maxActiveRuns, 4);
  assert.equal(agg.maxPeakConcurrency, 7);
});

test("summarizeSlo：interrupted / failed 不计入 successRate", () => {
  const runs = [
    slo(10, "completed"),
    slo(20, "failed"),
    slo(30, "interrupted"),
  ];
  const agg = summarizeSlo(runs);
  assert.equal(agg.successRate, 1 / 3);
});
