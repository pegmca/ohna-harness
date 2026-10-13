import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCostAttribution,
  extractCostInputs,
  summarizeCost,
  computeSloSummary,
  checkAutomationRegression,
  DEFAULT_REGRESSION_THRESHOLDS,
} from "../dist/index.js";

/** 浮点近似断言：1 - 0.8 等减法存在尾数误差，用 1e-9 容差避免脆断。 */
function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `期望 ≈ ${expected}，实际 ${actual}`);
}

/** 构造一条 message_end 事件（payload.message 为最小可用 AssistantMessage 视图）。 */
function messageEndEvent(model, provider, usage, seq = 1) {
  return {
    seq,
    type: "message_end",
    payload: { message: { role: "assistant", model, provider, usage } },
  };
}

/** 构造一条 tool_execution_end 事件（payload 含 toolName 与可选 result.usage）。 */
function toolEndEvent(toolName, usage, seq = 1) {
  return {
    seq,
    type: "tool_execution_end",
    payload: { toolCallId: `c${seq}`, toolName, result: usage ? { usage } : {}, isError: false },
  };
}

test("computeCostAttribution 按 model 聚合：token/cost/callCount 正确", () => {
  const events = [
    messageEndEvent("gpt-4o", "openai", { input: 100, output: 50, totalTokens: 150, cost: { total: 0.003 } }, 1),
    messageEndEvent("gpt-4o", "openai", { input: 200, output: 80, totalTokens: 280, cost: { total: 0.006 } }, 2),
    messageEndEvent("claude-3", "anthropic", { input: 300, output: 100, totalTokens: 400, cost: { total: 0.012 } }, 3),
  ];
  const byModel = computeCostAttribution(events, "model");
  assert.equal(byModel.length, 2);
  const gpt = byModel.find((r) => r.key === "gpt-4o");
  const claude = byModel.find((r) => r.key === "claude-3");
  assert.ok(gpt);
  assert.ok(claude);
  // gpt-4o 两条合并。
  assert.equal(gpt.inputTokens, 300);
  assert.equal(gpt.outputTokens, 130);
  assert.equal(gpt.totalTokens, 430);
  approx(gpt.cost, 0.009);
  assert.equal(gpt.callCount, 2);
  // claude-3 单条。
  assert.equal(claude.totalTokens, 400);
  approx(claude.cost, 0.012);
  assert.equal(claude.callCount, 1);
  // 按 totalTokens 降序：claude(400) 应排在 gpt(430) 之后？430 > 400 → gpt 在前。
  assert.equal(byModel[0].key, "gpt-4o");
});

test("computeCostAttribution 按 tool 聚合：仅 tool 事件计入", () => {
  const events = [
    toolEndEvent("search_filings", { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } }, 1),
    toolEndEvent("search_filings", { input: 20, output: 8, totalTokens: 28, cost: { total: 0.002 } }, 2),
    toolEndEvent("generate_report", { input: 40, output: 12, totalTokens: 52, cost: { total: 0.004 } }, 3),
    messageEndEvent("gpt-4o", "openai", { input: 100, output: 50, totalTokens: 150, cost: { total: 0.003 } }, 4),
  ];
  const byTool = computeCostAttribution(events, "tool");
  assert.equal(byTool.length, 2);
  const search = byTool.find((r) => r.key === "search_filings");
  assert.ok(search);
  assert.equal(search.totalTokens, 43);
  approx(search.cost, 0.003);
  assert.equal(search.callCount, 2);
  // message 事件不计入 tool 维度。
  assert.equal(byTool.find((r) => r.key === "gpt-4o"), undefined);
});

test("extractCostInputs 对缺失 usage / 非有限数字防御（不抛错，归 0）", () => {
  const events = [
    // 缺失 usage 的 message_end：应被跳过，不产生输入。
    { seq: 1, type: "message_end", payload: { message: { role: "assistant", model: "m", provider: "p" } } },
    // 非有限数字：toNumber 归 0，但仍产生输入（usage 存在）。
    messageEndEvent("m", "p", { input: NaN, output: Infinity, totalTokens: undefined, cost: { total: "x" } }, 2),
    // 缺失 usage 的 tool_execution_end：应被跳过。
    toolEndEvent("t", undefined, 3),
  ];
  const inputs = extractCostInputs(events);
  assert.equal(inputs.length, 1);
  const only = inputs[0];
  assert.equal(only.source, "message");
  assert.equal(only.model, "m");
  assert.equal(only.usage.input, 0);
  assert.equal(only.usage.output, 0);
  assert.equal(only.usage.totalTokens, 0);
  assert.equal(only.usage.cost.total, 0);
});

test("summarizeCost 返回合计与两个维度", () => {
  const events = [
    messageEndEvent("gpt-4o", "openai", { input: 100, output: 50, totalTokens: 150, cost: { total: 0.003 } }, 1),
    toolEndEvent("search_filings", { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } }, 2),
  ];
  const summary = summarizeCost(events);
  assert.equal(summary.byModel.length, 1);
  assert.equal(summary.byTool.length, 1);
  assert.equal(summary.totalTokens, 150 + 15);
  approx(summary.totalCost, 0.003 + 0.001);
});

test("computeSloSummary: p95 超预算 → breached true", () => {
  const metrics = {
    citationCoverage: 1, financialAccuracy: 1, sourceGroundedness: 1, successRate: 1,
    workflowCompletion: 1, reportSectionCoverage: 1, exportStatusRate: 1,
    averageLatencyMs: 5000, p95LatencyMs: 12000,
  };
  const slo = computeSloSummary(metrics, { ...DEFAULT_REGRESSION_THRESHOLDS, p95LatencyMs: 10000 });
  assert.equal(slo.p95LatencyMs.value, 12000);
  assert.equal(slo.p95LatencyMs.budget, 10000);
  assert.equal(slo.p95LatencyMs.breached, true);
  assert.equal(slo.errorBudget.breached, false);
});

test("computeSloSummary: successRate 低于阈值 → errorBudget breached true", () => {
  const metrics = {
    citationCoverage: 1, financialAccuracy: 1, sourceGroundedness: 1, successRate: 0.7,
    workflowCompletion: 1, reportSectionCoverage: 1, exportStatusRate: 1,
    averageLatencyMs: 100, p95LatencyMs: 200,
  };
  const slo = computeSloSummary(metrics, DEFAULT_REGRESSION_THRESHOLDS);
  // budget = 1 - 0.8 = 0.2；consumed = 1 - 0.7 = 0.3；0.3 > 0.2 → breached。
  approx(slo.errorBudget.budget, 0.2);
  approx(slo.errorBudget.consumed, 0.3);
  assert.equal(slo.errorBudget.remaining, 0);
  assert.equal(slo.errorBudget.breached, true);
  // p95 远低于预算，未突破。
  assert.equal(slo.p95LatencyMs.breached, false);
});

test("computeSloSummary: 达标情况 → 两项均不 breached", () => {
  const metrics = {
    citationCoverage: 1, financialAccuracy: 1, sourceGroundedness: 1, successRate: 0.95,
    workflowCompletion: 1, reportSectionCoverage: 1, exportStatusRate: 1,
    averageLatencyMs: 1000, p95LatencyMs: 3000,
  };
  const slo = computeSloSummary(metrics, DEFAULT_REGRESSION_THRESHOLDS);
  assert.equal(slo.p95LatencyMs.breached, false);
  assert.equal(slo.errorBudget.breached, false);
  // remaining = 0.2 - 0.05 = 0.15（浮点近似）。
  approx(slo.errorBudget.remaining, 0.15);
});

test("checkAutomationRegression 新增 p95 规则：p95 超阈值时含 p95 字样", () => {
  const metrics = {
    citationCoverage: 1, financialAccuracy: 1, sourceGroundedness: 1, successRate: 1,
    workflowCompletion: 1, reportSectionCoverage: 1, exportStatusRate: 1,
    averageLatencyMs: 9000, p95LatencyMs: 20000,
  };
  const reasons = checkAutomationRegression(metrics, undefined, { ...DEFAULT_REGRESSION_THRESHOLDS, p95LatencyMs: 10000 });
  assert.ok(reasons.some((r) => r.includes("p95")), `期望含 p95 规则，实际: ${JSON.stringify(reasons)}`);
});

test("checkAutomationRegression: p95 在预算内不触发（零回归校验）", () => {
  const metrics = {
    citationCoverage: 1, financialAccuracy: 1, sourceGroundedness: 1, successRate: 1,
    workflowCompletion: 1, reportSectionCoverage: 1, exportStatusRate: 1,
    averageLatencyMs: 100, p95LatencyMs: 200,
  };
  const reasons = checkAutomationRegression(metrics, undefined, { ...DEFAULT_REGRESSION_THRESHOLDS, p95LatencyMs: 10000 });
  assert.equal(reasons.length, 0);
});
