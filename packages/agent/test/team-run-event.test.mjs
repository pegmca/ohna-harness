/**
 * cost_summary 投影测试（docs/v2.0/03-team-eval.md §6.2：projectTeamCostSummary 归 L1 纯函数）。
 *
 * 迁移说明：旧版本用 `createMockStreamFn` 回放固定带 usage 的 assistant 消息，再跑一遍真实的
 * `agentLoop` 才能拿到 TeamState——这属于「mock 模型输出」（§4.2 红线），且把「投影逻辑正确性」
 * 与「agentLoop 能跑通」两件事耦在一起。投影是纯函数，直接用**合成 TeamState** 构造期望即可：
 * 零模型、100% 确定；「真 provider 下这些字段确实被串起来」由 team-l2b-provider.test.mjs 覆盖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectTeamCostSummary, projectContextBudgetSummary } from "../dist/team/run-event.js";
import { summarizeBudgetReports } from "../dist/context-assembly.js";

/**
 * 构造一个 Model 元数据（测试用，字段对齐 @aiagent/ai 的 Model）。
 *
 * @param id 模型 id。
 * @returns Model 对象。
 */
function makeModel(id = "test-model") {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/**
 * 构造一个成员（使用量与状态均可显式指定，便于纯函数断言）。
 *
 * @param name 成员名。
 * @param patch 覆盖字段（usage / budgetExceeded / durationMs / model）。
 * @returns TeamMember 形状的对象。
 */
function member(name, patch = {}) {
  return {
    name,
    role: "评审",
    model: patch.model ?? makeModel("m"),
    status: "done",
    ...patch,
  };
}

/**
 * 构造一个 TeamState 快照。
 *
 * @param members TeamMember 数组。
 * @param patch 覆盖字段（events / peakConcurrency）。
 * @returns TeamState 形状的对象。
 */
function teamState(members, patch = {}) {
  return {
    members: new Map(members.map((m) => [m.name, m])),
    inboundQueues: new Map(),
    events: [],
    ...patch,
  };
}

test("projectTeamCostSummary：各成员 tokens/cost 原样投影，total 为之和", () => {
  const summary = projectTeamCostSummary(
    teamState([
      member("bull", { usage: { tokens: 500, cost: 0.05 }, durationMs: 12 }),
      member("bear", { usage: { tokens: 400, cost: 0.03 }, durationMs: 0 }),
      member("risk", { usage: { tokens: 600, cost: 0.07 } }),
    ]),
  );

  assert.equal(summary.members.length, 3);
  assert.deepEqual(
    summary.members.map((m) => m.name),
    ["bull", "bear", "risk"],
    "成员顺序与 Map 插入顺序一致",
  );
  assert.deepEqual(summary.members[0], {
    name: "bull",
    model: "m",
    tokens: 500,
    cost: 0.05,
    budgetExceeded: false,
    durationMs: 12,
  });
  // durationMs=0 是合法观测值（跑得极快），必须保留而不是被当成「缺失」。
  assert.equal(summary.members[1].durationMs, 0);
  // 未跑过的成员不含 durationMs 键。
  assert.equal("durationMs" in summary.members[2], false);
  // total 为各成员之和（浮点用容差比较）。
  assert.equal(summary.totalTokens, 1500);
  assert.ok(Math.abs(summary.totalCost - 0.15) < 1e-9);
});

test("projectTeamCostSummary：budgetExceeded 正确投影，且防御式处理缺失 usage", () => {
  const over = projectTeamCostSummary(
    teamState([member("analyst", { usage: { tokens: 1000, cost: 0.07 }, budgetExceeded: true, durationMs: 5 })]),
  );
  assert.equal(over.members[0].budgetExceeded, true);
  assert.equal(over.members[0].tokens, 1000);
  assert.equal(over.members[0].cost, 0.07);

  // 防御式：缺失 usage 的成员视为 0 且仍保留在列表（§9.1.4 语义差异 1：0 用量成员也输出）。
  const defensive = projectTeamCostSummary(teamState([member("ghost", { status: "idle", model: makeModel("g") })]));
  assert.equal(defensive.members.length, 1);
  assert.equal(defensive.members[0].tokens, 0);
  assert.equal(defensive.members[0].cost, 0);
  assert.equal(defensive.members[0].budgetExceeded, false);
  assert.equal("durationMs" in defensive.members[0], false);
  assert.equal(defensive.totalTokens, 0);
  assert.equal(defensive.totalCost, 0);

  // 非有限数值（脏观测）按 0 处理，绝不抛异常。
  const dirty = projectTeamCostSummary(
    teamState([
      member("dirty", { usage: { tokens: Number.NaN, cost: Number.POSITIVE_INFINITY }, durationMs: Number.NaN }),
    ]),
  );
  assert.equal(dirty.members[0].tokens, 0);
  assert.equal(dirty.members[0].cost, 0);
  assert.equal("durationMs" in dirty.members[0], false);
});

test("projectTeamCostSummary：peakConcurrency 仅在有限且已观测时并入", () => {
  const none = projectTeamCostSummary(teamState([member("a")]));
  assert.equal("peakConcurrency" in none, false, "未并发时不得误报容量 0");

  const three = projectTeamCostSummary(teamState([member("a"), member("b"), member("c")], { peakConcurrency: 3 }));
  assert.equal(three.peakConcurrency, 3);

  const dirty = projectTeamCostSummary(teamState([member("a")], { peakConcurrency: Number.NaN }));
  assert.equal("peakConcurrency" in dirty, false, "非有限峰值不并入");
});

test("projectTeamCostSummary：空团队成员表返回零值聚合（不抛错）", () => {
  const empty = projectTeamCostSummary(teamState([]));
  assert.deepEqual(empty, { members: [], totalTokens: 0, totalCost: 0 });
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
