import assert from "node:assert/strict";
import test from "node:test";
import { diffBaseline, evaluateGate, gateReport } from "../dist/index.js";

/** 构造最小 EvalReportDto。 */
function report(metrics) {
  return {
    target: "t",
    dataset: "d",
    createdAt: "2026-01-01T00:00:00Z",
    metrics,
    cases: [],
  };
}

test("baseline===null 时 diffBaseline 返回空数组", () => {
  const diff = diffBaseline(report([{ name: "m", value: 0.9 }]), null);
  assert.deepEqual(diff, []);
});

test("evaluateGate 空 diff（无 SLO 可违例）视为通过，不误报「无 baseline」", () => {
  // 语义解耦：evaluateGate 只负责「有 baseline 时」的 SLO 判定。
  // 空 diff（可能来自两报告都只含 applicable===false 指标等真实情况）不再误报为「无 baseline」。
  const result = evaluateGate([], [{ metric: "m", min: 0.8 }]);
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.reasons, []);
});

test("gateReport 在 baseline===null 时拦截 + 明确 reason（§5 统一语义 / Step 2 验收）", () => {
  // 统一封装 gateReport 是两 app 共享的 baseline 缺失语义收口点：首次跑直接拦截并提示建基线，
  // 避免两个 app 各自解释「无 baseline 是放行还是拦停」。
  const result = gateReport(report([{ name: "m", value: 0.9 }]), null, [{ metric: "m", min: 0.8 }]);
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.reasons.some((r) => r.includes("--update-baseline")));
});

test("gateReport 有 baseline 时委托 evaluateGate 做 SLO 判定", () => {
  const curr = report([{ name: "m", value: 0.5 }]);
  const base = report([{ name: "m", value: 0.9 }]);
  const fail = gateReport(curr, base, [{ metric: "m", maxRegression: 0.2 }]);
  assert.equal(fail.passed, false);
  assert.ok(fail.reasons.some((r) => r.includes("回退")));

  const pass = gateReport(report([{ name: "m", value: 0.9 }]), report([{ name: "m", value: 0.85 }]), [
    { metric: "m", min: 0.8, maxRegression: 0.2 },
  ]);
  assert.equal(pass.passed, true);
  assert.equal(pass.exitCode, 0);
});

test("diffBaseline 在 baseline===null 时返回空数组（gateReport 在此之上收口提示语义）", () => {
  const diff = diffBaseline(report([{ name: "m", value: 0.9 }]), null);
  assert.deepEqual(diff, []);
});

test("diffBaseline 标记 new / missing / regression / improvement / unchanged", () => {
  const curr = report([
    { name: "a", value: 0.9, applicable: true },
    { name: "b", value: 0.5, applicable: true },
  ]);
  const base = report([
    { name: "a", value: 0.8, applicable: true },
    { name: "c", value: 0.7, applicable: true },
  ]);
  const diff = diffBaseline(curr, base);
  const byName = Object.fromEntries(diff.map((d) => [d.metric, d]));
  assert.equal(byName.a.status, "improvement");
  assert.equal(byName.b.status, "new");
  assert.equal(byName.c.status, "missing");
});

test("G5：applicable===false 的指标不进 diff", () => {
  const curr = report([
    { name: "citationCoverage", value: 1, applicable: false }, // 无期望字段的 chat case
    { name: "retrievalHitRate", value: 0.9, applicable: true },
  ]);
  const base = report([
    { name: "retrievalHitRate", value: 0.85, applicable: true },
  ]);
  const diff = diffBaseline(curr, base);
  const names = diff.map((d) => d.metric);
  assert.ok(!names.includes("citationCoverage"));
  assert.ok(names.includes("retrievalHitRate"));
});

test("evaluateGate 校验 min 绝对下限", () => {
  const diff = diffBaseline(
    report([{ name: "m", value: 0.7 }]),
    report([{ name: "m", value: 0.9 }]),
  );
  const fail = evaluateGate(diff, [{ metric: "m", min: 0.8 }]);
  assert.equal(fail.passed, false);
  assert.equal(fail.exitCode, 1);
  assert.ok(fail.reasons.some((r) => r.includes("下限")));
});

test("evaluateGate 校验相对回归 maxRegression", () => {
  const diff = diffBaseline(
    report([{ name: "m", value: 0.5 }]),
    report([{ name: "m", value: 0.9 }]),
  );
  const fail = evaluateGate(diff, [{ metric: "m", maxRegression: 0.2 }]);
  assert.equal(fail.passed, false);
  assert.ok(fail.reasons.some((r) => r.includes("回退")));
});

test("evaluateGate 全部满足则通过 exitCode 0", () => {
  const diff = diffBaseline(
    report([{ name: "m", value: 0.9 }]),
    report([{ name: "m", value: 0.85 }]),
  );
  const pass = evaluateGate(diff, [{ metric: "m", min: 0.8, maxRegression: 0.2 }]);
  assert.equal(pass.passed, true);
  assert.equal(pass.exitCode, 0);
  assert.deepEqual(pass.reasons, []);
});
