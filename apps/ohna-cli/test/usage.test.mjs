/**
 * 会话用量单测：reasoning token 跨轮累计、快照恢复，以及 /cost 文案只在 >0 时括注。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createUsageTracker, formatCostLine } from "../dist/session/usage.js";

/** 构造一条最小 Usage。 */
function usage(overrides) {
  return { input: 0, output: 0, totalTokens: 0, cost: { total: 0 }, ...overrides };
}

test("UsageTracker：reasoning 是 output 子集，单独累计且不改变 total", () => {
  const tracker = createUsageTracker();
  tracker.add(usage({ input: 10, output: 20, totalTokens: 30, reasoning: 7, cost: { total: 0.01 } }));
  tracker.add(usage({ input: 1, output: 2, totalTokens: 3, reasoning: 1, cost: { total: 0.02 } }));

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.total, 33, "total 仍按 provider 的 totalTokens 累计");
  assert.equal(snapshot.output, 22);
  assert.equal(snapshot.reasoning, 8);
});

test("UsageTracker：旧快照缺 reasoning 时按 0 恢复", () => {
  const tracker = createUsageTracker();
  tracker.restore({ input: 1, output: 2, total: 3, cost: 0.1 });
  assert.equal(tracker.snapshot().reasoning, 0);
});

test("formatCostLine：reasoning > 0 时括注推理 token", () => {
  const tracker = createUsageTracker();
  tracker.add(usage({ input: 10, output: 20, totalTokens: 30, reasoning: 7, cost: { total: 0.01 } }));
  const line = formatCostLine(tracker);
  assert.match(line, /输出 20（推理 7）/);
  assert.match(line, /token 30/);
});

test("formatCostLine：reasoning 为 0 / 缺省时不出现「推理」", () => {
  const tracker = createUsageTracker();
  tracker.add(usage({ input: 10, output: 20, totalTokens: 30, cost: { total: 0.01 } }));
  assert.doesNotMatch(formatCostLine(tracker), /推理/);
});
