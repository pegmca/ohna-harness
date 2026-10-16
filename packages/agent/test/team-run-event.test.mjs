import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import {
  createTeamController,
  getTeamView,
} from "../dist/team-controller.js";
import {
  projectTeamCostSummary,
  projectContextBudgetSummary,
} from "../dist/team/run-event.js";
import { summarizeBudgetReports } from "../dist/context-assembly.js";

/** 构造一个 Model（测试用，字段对齐 @aiagent/ai 的 Model）。 */
function makeModel(id = "mock-model") {
  return {
    id,
    name: "Mock",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/** 构造一条带自定义 usage 的 assistant 消息（测试成本护栏用）。 */
function costedMessage(text, totalTokens, costTotal) {
  const m = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: totalTokens / 2,
      output: totalTokens / 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return m;
}

/** 构造 mock streamFn：每次调用返回一条固定 assistant 消息的事件流（start → done）。 */
function createMockStreamFn(message) {
  return () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
}

test("projectTeamCostSummary：各成员 tokens/cost 与 mock 一致，total 为之和", async () => {
  // 每个成员单轮产生已知 usage；护栏配置保证用量被回写（不渲染 0 行）。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: createMockStreamFn(costedMessage("结论", 500, 0.05)),
    budget: { maxCostPerMember: 1, maxCostTotal: 1 },
    maxConcurrentMembers: 3,
  });
  for (const name of ["bull", "bear", "risk"]) {
    await controller.createMember({ name, role: "评审" });
  }
  await controller.runMembers(["bull", "bear", "risk"], "任务", 3);

  const state = controller.getTeamState();
  const summary = projectTeamCostSummary(state);

  // (a) 每个成员 tokens/cost 与 mock 一致。
  assert.equal(summary.members.length, 3);
  for (const m of summary.members) {
    assert.equal(m.tokens, 500);
    assert.equal(m.cost, 0.05);
    assert.equal(m.model, "m");
    assert.equal(m.budgetExceeded, false);
  }
  // (c) totalTokens/totalCost 为各成员之和（cost 用容差比较，规避浮点累加误差）。
  assert.equal(summary.totalTokens, 1500);
  assert.ok(Math.abs(summary.totalCost - 0.15) < 1e-9);

  // (d) SLO 容量证据：每个成员回填了有限墙钟 durationMs；team 段带并发峰值（maxConcurrentMembers=3 全并发 → 3）。
  for (const m of summary.members) {
    assert.equal(typeof m.durationMs, "number");
    assert.ok(Number.isFinite(m.durationMs) && m.durationMs >= 0, "成员 durationMs 应为有限非负数");
  }
  assert.equal(summary.peakConcurrency, 3, "三成员并发运行，观测到的在飞峰值应为 3");
});

test("projectTeamCostSummary：budgetExceeded 正确投影，且防御式处理缺失 usage", async () => {
  // 单轮 usage 即超 per-member 成本上限 → 该成员 budgetExceeded=true。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: createMockStreamFn(costedMessage("部分结论", 1000, 0.07)),
    budget: { maxCostPerMember: 0.05 },
  });
  await controller.createMember({ name: "analyst", role: "研究员" });
  await controller.runMembers(["analyst"], "分析", 1);

  const state = controller.getTeamState();
  const summary = projectTeamCostSummary(state);
  assert.equal(summary.members.length, 1);
  assert.equal(summary.members[0].budgetExceeded, true);
  assert.equal(summary.members[0].tokens, 1000);
  assert.equal(summary.members[0].cost, 0.07);

  // 防御式：手动构造一个缺失 usage 的成员，应视为 0 且仍保留在列表。
  const defensiveState = {
    members: new Map([
      ["ghost", { name: "ghost", role: "x", model: makeModel("g"), status: "idle" }],
    ]),
    inboundQueues: new Map(),
    events: [],
  };
  const d = projectTeamCostSummary(defensiveState);
  assert.equal(d.members.length, 1);
  assert.equal(d.members[0].tokens, 0);
  assert.equal(d.members[0].cost, 0);
  assert.equal(d.members[0].budgetExceeded, false);
  assert.equal(d.totalTokens, 0);
  assert.equal(d.totalCost, 0);
});

test("projectContextBudgetSummary：聚合命中率/丢弃率/超预算/丢弃计数正确", () => {
  // 构造三份 ContextBudgetReport：两份命中率 1、丢弃率 0；一份超预算且发生丢弃。
  const reports = [
    {
      budgetTokens: 1000,
      injectedTokens: 500,
      workingKept: true,
      retrievedKept: 2,
      retrievedDiscarded: 0,
      retrievedAvailable: 2,
      memoryHitRate: 0.5,
      discardRate: 0,
      tier: "medium",
    },
    {
      budgetTokens: 1000,
      injectedTokens: 800,
      workingKept: true,
      retrievedKept: 3,
      retrievedDiscarded: 0,
      retrievedAvailable: 3,
      memoryHitRate: 0.8,
      discardRate: 0,
      tier: "medium",
    },
    {
      budgetTokens: 1000,
      injectedTokens: 1200, // 超过预算上限 → overBudgetCount++
      workingKept: false,
      retrievedKept: 1,
      retrievedDiscarded: 2, // 发生丢弃 → discardedCount++
      retrievedAvailable: 3,
      memoryHitRate: 1,
      discardRate: 2 / 3,
      tier: "high",
    },
  ];

  const summary = projectContextBudgetSummary(reports);
  assert.equal(summary.count, 3);
  assert.equal(summary.averageMemoryHitRate, (0.5 + 0.8 + 1) / 3);
  assert.equal(summary.averageDiscardRate, (0 + 0 + 2 / 3) / 3);
  assert.equal(summary.overBudgetCount, 1);
  assert.equal(summary.discardedCount, 1);

  // 与 context-assembly 的 summarizeBudgetReports 行为一致（投影层只是形状对齐）。
  assert.deepEqual(summary, summarizeBudgetReports(reports));

  // 空数组返回全 0 零值聚合（不抛错）。
  const empty = projectContextBudgetSummary([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.averageMemoryHitRate, 0);
  assert.equal(empty.overBudgetCount, 0);
});
