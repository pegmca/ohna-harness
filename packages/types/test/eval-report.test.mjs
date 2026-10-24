import assert from "node:assert/strict";
import test from "node:test";

/**
 * `packages/types/src/eval-report.ts` 是跨边界线格式（EvalReportDto / BaselineDiff / GateResult），
 * 属「类型 + 文档化语义」，运行时只暴露类型（被擦除）。本测试聚焦两点：
 * 1. 基础形状（字段结构，TS 接口在运行时被擦除，这里用结构化断言说明契约）；
 * 2. G5 核心语义：`EvalMetricValue.applicable` 缺省为 `true`，`false` 时内核跳过聚合 / 门禁。
 *
 * 内核判定规则（`packages/eval-core` 的 gate.ts / report.ts 均以此过滤）：
 *   `metric.applicable !== false` 即视为参与聚合（见 eval-core/src/gate.ts applicableMetrics）。
 * 该规则是 eval-report.ts 契约的一部分，这里用本地谓词镜像它并断言缺省语义。
 */
const isApplicable = (metric) => metric.applicable !== false;

test("EvalMetricValue 基础形状：name/value 必填，unit/applicable 可选", () => {
  const metric = { name: "retrievalHitRate", value: 0.9, unit: "ratio" };
  assert.equal(metric.name, "retrievalHitRate");
  assert.equal(metric.value, 0.9);
  assert.equal(metric.unit, "ratio");
  // 未设置 applicable 字段 —— 缺省语义见下一条。
  assert.equal("applicable" in metric, false);
});

test("G5：applicable 缺省视为 true（参与聚合）", () => {
  // 修复前：无期望字段的指标因缺字段被默认排除，或满分参与聚合虚高。
  // 修复后：缺省 true，仅显式 false 才跳过（镜像 eval-core 的 `applicable !== false` 规则）。
  const noField = { name: "citationCoverage", value: 1 };
  const explicitTrue = { name: "retrievalHitRate", value: 0.9, applicable: true };
  assert.equal(isApplicable(noField), true);
  assert.equal(isApplicable(explicitTrue), true);
});

test("G5：applicable===false 的指标被判定为不参与聚合", () => {
  const chatCaseMetric = { name: "citationCoverage", value: 1, applicable: false };
  assert.equal(isApplicable(chatCaseMetric), false);
});

test("EvalReportDto 基础形状 + applicable 缺省语义贯穿聚合", () => {
  // 仅作结构化形状说明：report 本身不携带 applicable，聚合由 metrics[] 上的 applicable 决定。
  const report = {
    target: "finance-api", // string 不枚举 app
    dataset: "rag-v1",
    createdAt: "2026-10-24T00:00:00Z",
    metrics: [
      { name: "retrievalHitRate", value: 0.9 }, // 缺省 applicable=true
      { name: "citationCoverage", value: 1, applicable: false }, // 无期望字段的 chat case
    ],
    cases: [{ id: "c1", passed: true }],
  };
  assert.equal(report.target, "finance-api");
  assert.equal(report.cases.length, 1);
  // 聚合 / 门禁前用 isApplicable 过滤：applicable=false 被跳过（修 G5）。
  const applicable = report.metrics.filter(isApplicable);
  assert.deepEqual(applicable.map((m) => m.name), ["retrievalHitRate"]);
});

test("BaselineDiff / GateResult 形状说明", () => {
  const diff = { metric: "m", current: 0.9, baseline: 0.85, delta: 0.05, status: "improvement" };
  assert.equal(diff.status, "improvement");
  const gate = { passed: false, reasons: ["无 baseline，需先 --update-baseline"], exitCode: 1 };
  assert.equal(gate.passed, false);
  assert.equal(gate.exitCode, 1); // 直接映射 process.exitCode
  assert.ok(gate.reasons.some((r) => r.includes("--update-baseline")));
});
