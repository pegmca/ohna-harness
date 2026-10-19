import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compact,
  createCompactionTransform,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact
} from "../dist/index.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "mock",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

function assistantWithToolCall(id, name, args) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "mock",
    model: "mock",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
    stopReason: "toolUse",
    timestamp: Date.now()
  };
}

function toolResult(toolCallId, toolName, text, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError,
    timestamp: Date.now()
  };
}

const SETTINGS = { enabled: true, reserveTokens: 10, keepRecentTokens: 50 };

test("estimateTokens uses the chars/4 heuristic", () => {
  assert.equal(estimateTokens(userMessage("a".repeat(40))), 10);
  const withToolCall = assistantWithToolCall("t1", "echo", { value: "abcd" });
  assert.ok(estimateTokens(withToolCall) > 0);
});

test("estimateTokens / estimateContextTokens 支持 user content 块数组（@ 文件引用）", () => {
  // F-6：`@` 引用把用户消息扩成 [原文本, 文件块]，压缩估算必须按全部文本块求和，
  // 不能因为 content 不是 string 而漏算（漏算会让上下文在真实超窗时仍不触发压缩）。
  const content = [
    { type: "text", text: "看看文件" },
    { type: "text", text: "文件 a.ts：\n" + "x".repeat(40) },
  ];
  const message = { role: "user", content, timestamp: 1 };
  assert.equal(estimateTokens(message), 14); // 4 + 9 + 40 字符 → ceil(53/4)
  assert.equal(estimateContextTokens([message]), 14);
});

test("estimateContextTokens prefers the last assistant usage and adds the tail", () => {
  const withUsage = assistantText("answer");
  withUsage.usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: ZERO_COST };
  const messages = [userMessage("q"), withUsage, userMessage("a".repeat(40))];

  // usage 1100 + 尾部 user 消息 10。
  assert.equal(estimateContextTokens(messages), 1110);
});

test("shouldCompact triggers on contextWindow - reserveTokens", () => {
  assert.equal(shouldCompact(91, 100, SETTINGS), true);
  assert.equal(shouldCompact(90, 100, SETTINGS), false);
  assert.equal(shouldCompact(80, 100, SETTINGS), false);
  assert.equal(shouldCompact(95, 100, { ...SETTINGS, enabled: false }), false);
});

test("compaction replaces the prefix with a CompactionMessage at the head", () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push(userMessage(`问题 ${i} ${"长".repeat(60)}`));
    messages.push(assistantText(`回答 ${i} ${"长".repeat(60)}`));
  }
  const tokensBefore = estimateContextTokens(messages);
  const preparation = prepareCompaction(messages, SETTINGS);
  assert.ok(preparation);
  assert.ok(preparation.messagesToSummarize.length > 0);

  const result = compact(messages, "前 10 轮讨论的历史摘要", SETTINGS);
  assert.equal(result[0].role, "compaction");
  assert.equal(result[0].summary, "前 10 轮讨论的历史摘要");
  assert.equal(result[0].tokensBefore, tokensBefore);
  assert.equal(result[0].summarizedMessageCount, preparation.messagesToSummarize.length);
  // 保留的后缀原样跟在后面。
  assert.deepEqual(result.slice(1), messages.slice(preparation.firstKeptIndex));
  assert.ok(estimateContextTokens(result) < tokensBefore);
});

test("cut point never splits toolCalls from their ToolResultMessage", () => {
  const messages = [
    userMessage(`开头 ${"长".repeat(80)}`),
    assistantWithToolCall("call_1", "financial_metric", { ticker: "000001.SZ" }),
    toolResult("call_1", "financial_metric", `指标结果 ${"长".repeat(60)}`),
    assistantText(`解读 ${"长".repeat(60)}`),
    userMessage(`追问 ${"长".repeat(60)}`),
    assistantWithToolCall("call_2", "market_data", { ticker: "000001.SZ" }),
    toolResult("call_2", "market_data", `行情结果 ${"长".repeat(40)}`)
  ];

  const preparation = prepareCompaction(messages, { enabled: true, reserveTokens: 10, keepRecentTokens: 30 });
  assert.ok(preparation);
  // 切点绝不落在 toolResult 上。
  assert.notEqual(messages[preparation.firstKeptIndex].role, "toolResult");

  const result = compact(messages, "摘要", { enabled: true, reserveTokens: 10, keepRecentTokens: 30 });
  const kept = result.slice(1);
  // 配对完整性：保留的每个 toolResult，其 toolCall 所在的 assistant 也被保留。
  const keptToolCallIds = new Set(
    kept.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c) => c.type === "toolCall").map((c) => c.id))
  );
  for (const message of kept) {
    if (message.role === "toolResult") {
      assert.ok(keptToolCallIds.has(message.toolCallId), `orphan toolResult: ${message.toolCallId}`);
    }
  }
  // 反向配对：保留的每个 toolCall，其 ToolResultMessage 也必须被保留（不许只有调用没有结果）。
  const keptToolResultIds = new Set(kept.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const message of kept) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          assert.ok(keptToolResultIds.has(block.id), `toolCall without toolResult: ${block.id}`);
        }
      }
    }
  }
});

test("previous CompactionMessage becomes previousSummary for iterative updates", () => {
  const messages = [
    { role: "compaction", summary: "旧摘要", tokensBefore: 100, summarizedMessageCount: 5, timestamp: Date.now() },
    userMessage(`新问题 ${"长".repeat(80)}`),
    assistantText(`新回答 ${"长".repeat(80)}`)
  ];
  const preparation = prepareCompaction(messages, { enabled: true, reserveTokens: 10, keepRecentTokens: 10 });
  assert.ok(preparation);
  assert.equal(preparation.previousSummary, "旧摘要");
});

test("createCompactionTransform compacts over-threshold contexts and passes through small ones", async () => {
  const summarizerCalls = [];
  const transform = createCompactionTransform({
    contextWindow: 120,
    settings: { reserveTokens: 10, keepRecentTokens: 30 },
    summarizer: async (messagesToSummarize, previousSummary) => {
      summarizerCalls.push({ count: messagesToSummarize.length, previousSummary });
      return "压缩摘要文本";
    }
  });

  const small = [userMessage("短问题")];
  assert.deepEqual(await transform(small), small);

  const large = [];
  for (let i = 0; i < 8; i++) {
    large.push(userMessage(`问题 ${i} ${"长".repeat(50)}`));
    large.push(assistantText(`回答 ${i} ${"长".repeat(50)}`));
  }
  const result = await transform(large);
  assert.equal(summarizerCalls.length, 1);
  assert.equal(result[0].role, "compaction");
  assert.equal(result[0].summary, "压缩摘要文本");
});

test("createCompactionTransform 就地写回 context，下一轮不再重复触发摘要", async () => {
  const summarizerCalls = [];
  const transform = createCompactionTransform({
    contextWindow: 120,
    settings: { reserveTokens: 10, keepRecentTokens: 30 },
    summarizer: async (messagesToSummarize, previousSummary) => {
      summarizerCalls.push({ count: messagesToSummarize.length, previousSummary });
      return "压缩摘要文本";
    }
  });

  const context = [];
  for (let i = 0; i < 8; i++) {
    context.push(userMessage(`问题 ${i} ${"长".repeat(50)}`));
    context.push(assistantText(`回答 ${i} ${"长".repeat(50)}`));
  }
  // 第一次触发压缩，且原数组被就地写回（loop 传入的是 context.messages 同一引用）。
  const first = await transform(context);
  assert.equal(first, context);
  assert.equal(context[0].role, "compaction");
  assert.equal(summarizerCalls.length, 1);

  // 压缩后的序列低于阈值，下一轮同一 context 不再触发 summarizer。
  const second = await transform(context);
  assert.equal(second, context);
  assert.equal(summarizerCalls.length, 1);
});
