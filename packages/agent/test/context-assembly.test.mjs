import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleMemoryBlocks,
  buildSystemPromptWithMemory,
  computeMemoryBudgetTokens,
  createContextAssemblyTransform,
  defaultDeriveQuery,
  formatMemoryAsUserMessage,
  limitContextByBudget,
  DEFAULT_CONTEXT_BUDGET,
} from "../dist/context-assembly.js";

/** 构造一条 user 消息（测试用）。 */
function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}
/** 构造一条 CompactionMessage（测试用，验证 transform 不破坏既有行为）。 */
function compactionMessage(summary) {
  return { role: "compaction", summary, tokensBefore: 100, summarizedMessageCount: 5, timestamp: Date.now() };
}

test("computeMemoryBudgetTokens scales with tier", () => {
  const base = { tier: "medium", contextWindow: 100000, reserveTokens: 10000 };
  assert.equal(computeMemoryBudgetTokens({ ...base, tier: "low" }), Math.floor(90000 * 0.05));
  assert.equal(computeMemoryBudgetTokens({ ...base, tier: "medium" }), Math.floor(90000 * 0.15));
  assert.equal(computeMemoryBudgetTokens({ ...base, tier: "high" }), Math.floor(90000 * 0.3));
  // contextWindow 小于 reserveTokens 时下限为 0。
  assert.equal(computeMemoryBudgetTokens({ ...base, contextWindow: 5000, reserveTokens: 10000 }), 0);
});

test("DEFAULT_CONTEXT_BUDGET is a valid medium-tier budget", () => {
  assert.equal(DEFAULT_CONTEXT_BUDGET.tier, "medium");
  assert.ok(DEFAULT_CONTEXT_BUDGET.contextWindow > DEFAULT_CONTEXT_BUDGET.reserveTokens);
});

test("assembleMemoryBlocks fences working and retrieved memory and counts tokens", () => {
  const assembled = assembleMemoryBlocks({
    workingMemory: "当前任务是分析财报",
    retrievedMemory: ["2023 年报摘要", "2024 季报摘要"],
  });
  assert.ok(assembled.working);
  assert.match(assembled.working.content, /^\[工作记忆\]\n/);
  assert.match(assembled.working.content, /\[\/工作记忆\]$/);
  assert.equal(assembled.retrieved.length, 2);
  assert.match(assembled.retrieved[0].content, /^\[检索记忆 1\]\n/);
  assert.match(assembled.retrieved[1].content, /^\[检索记忆 2\]\n/);
  // 围栏后的 token 应大于裸文本（含标签开销）。
  assert.ok(assembled.totalTokens > Math.ceil("当前任务是分析财报".length / 4));
});

test("assembleMemoryBlocks ignores empty/null inputs", () => {
  const assembled = assembleMemoryBlocks({ workingMemory: "   ", retrievedMemory: [null, "", "   "] });
  assert.equal(assembled.working, null);
  assert.equal(assembled.retrieved.length, 0);
  assert.equal(assembled.totalTokens, 0);
});

test("limitContextByBudget keeps working memory first, then trims retrieved to fit", () => {
  // 每条检索记忆约 40 字符 ≈ 10 token；工作记忆约 40 字符 ≈ 10 token。
  const input = {
    workingMemory: "a".repeat(40),
    retrievedMemory: ["b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40)],
  };
  const assembled = assembleMemoryBlocks(input);
  // 围栏开销下工作记忆≈14、单条检索≈15 token。用 tierRatios 把 low 预算压到 29：
  // 工作(14)+第一条检索(15)=29 放得下，加第二条(44) 超预算被裁，证明检索记忆可独立丢弃。
  const limited = limitContextByBudget(
    assembled,
    { tier: "low", contextWindow: 1000, reserveTokens: 100, tierRatios: { low: 0.033 } },
    1000,
  );
  assert.ok(limited.working);
  assert.equal(limited.retrieved.length, 1);
  assert.ok(limited.totalTokens <= 29);
});

test("limitContextByBudget drops working memory if it alone exceeds the budget", () => {
  const assembled = assembleMemoryBlocks({ workingMemory: "x".repeat(400), retrievedMemory: ["y".repeat(40)] });
  const limited = limitContextByBudget(assembled, { tier: "low", contextWindow: 500, reserveTokens: 100 }, 500);
  assert.equal(limited.working, null);
  // 工作记忆 100 字符=25 token 超过 20 预算被丢弃；检索记忆(10) 保留。
  assert.equal(limited.retrieved.length, 1);
});

test("buildSystemPromptWithMemory appends a memory section and is a no-op when empty", () => {
  const base = "你是金融研究助手";
  const empty = buildSystemPromptWithMemory(base, assembleMemoryBlocks({}));
  assert.equal(empty, base);

  const merged = buildSystemPromptWithMemory(base, assembleMemoryBlocks({ workingMemory: "状态：分析中" }));
  assert.match(merged, /^你是金融研究助手\n\n## 记忆上下文/);
  assert.match(merged, /\[工作记忆\]/);
});

test("formatMemoryAsUserMessage returns null when no memory", () => {
  assert.equal(formatMemoryAsUserMessage(assembleMemoryBlocks({})), null);
});

test("transform injects a prepended user memory message when budget allows", async () => {
  const transform = createContextAssemblyTransform({
    budget: { tier: "high", contextWindow: 100000, reserveTokens: 1000 },
    getWorkingMemory: () => "任务：复盘特斯拉财报",
    retrieveMemory: () => ["相关研报片段"],
  });
  const messages = [userMessage("请分析")];
  const out = await transform(messages);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.match(out[0].content, /\[工作记忆\]/);
  assert.ok(out[1].content.includes("请分析"));
  // 返回新数组，不就地改写入参。
  assert.equal(messages.length, 1);
});

test("transform no-ops when budget is too small for any memory", async () => {
  const transform = createContextAssemblyTransform({
    budget: { tier: "low", contextWindow: 500, reserveTokens: 100 },
    getWorkingMemory: () => "x".repeat(400),
    retrieveMemory: () => ["y".repeat(400)],
  });
  const messages = [userMessage("请分析")];
  const out = await transform(messages);
  assert.deepEqual(out, messages);
  assert.equal(out.length, 1);
});

test("transform does not throw when memory providers reject", async () => {
  const transform = createContextAssemblyTransform({
    budget: { tier: "high", contextWindow: 100000, reserveTokens: 1000 },
    getWorkingMemory: () => {
      throw new Error("boom");
    },
    retrieveMemory: () => {
      throw new Error("boom");
    },
  });
  const messages = [userMessage("请分析")];
  const out = await transform(messages);
  // 回调失败退化为无记忆，原样返回（遵守 transformContext 不得抛错契约）。
  assert.deepEqual(out, messages);
});

test("transform preserves CompactionMessage and prepends memory before it", async () => {
  const transform = createContextAssemblyTransform({
    budget: { tier: "high", contextWindow: 100000, reserveTokens: 1000 },
    getWorkingMemory: () => "短期状态",
    retrieveMemory: () => [],
  });
  const messages = [compactionMessage("历史摘要"), userMessage("追问")];
  const out = await transform(messages);
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "compaction");
  assert.equal(out[1].summary, "历史摘要");
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content, "追问");
});

test("defaultDeriveQuery picks the last user message text", () => {
  const messages = [userMessage("第一轮"), compactionMessage("摘要"), userMessage("最新问题")];
  assert.equal(defaultDeriveQuery(messages), "最新问题");
  assert.equal(defaultDeriveQuery([compactionMessage("只有摘要")]), undefined);
});
