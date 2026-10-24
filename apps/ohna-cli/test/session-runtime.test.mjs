/**
 * session-runtime 纯逻辑单测：会话级压缩触发、失败降级、摘要兜底。
 *
 * 这里不调用真实模型：summarizer 用桩函数，验证的是「何时压缩 / 压缩失败怎么办」，
 * 与 provider 行为解耦（真实摘要的手工验证见文档 C-M2-3）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFallbackSummary,
  buildSummaryTranscript,
  compactSessionHistory,
  createLlmSummarizer,
  filterFailedAssistants,
  resolveCompactionSettings,
  withSummaryFallback,
} from "../dist/runtime/summarizer.js";

/** 构造一条足够长的 user 消息（约 2000 token）。 */
function longUserMessage(index) {
  return { role: "user", content: `第 ${index} 条：` + "上下文内容".repeat(1000), timestamp: index };
}

/** 构造带 usage 的 assistant 消息，便于验证 usage 锚点与截断。 */
function assistantMessage(text, usageTotal = 25_100, timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "stub",
    usage: {
      input: usageTotal - 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usageTotal,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

/** 构造压缩用例：30 条长消息，总量超过 keepRecentTokens。 */
function buildLongHistory() {
  return Array.from({ length: 30 }, (_, index) => longUserMessage(index));
}

test("resolveCompactionSettings：大窗口沿用默认值，小窗口按比例收缩", () => {
  const large = resolveCompactionSettings(128_000);
  assert.equal(large.reserveTokens, 16_384);
  assert.equal(large.keepRecentTokens, 20_000);

  const small = resolveCompactionSettings(8_000);
  assert.ok(small.reserveTokens < 8_000);
  assert.ok(small.keepRecentTokens < 8_000);
  // 保留量与预留量都必须小于窗口，否则切点永远切不出可摘要前缀。
  assert.ok(small.reserveTokens + small.keepRecentTokens < 8_000);
});

test("compactSessionHistory：未超阈值时不压缩，返回原序列", async () => {
  const messages = [longUserMessage(1)];
  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 1_000_000 },
    summarizer: async () => "不应被调用",
  });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(result.messageCountBefore, 1);
});

test("compactSessionHistory：超阈值时摘要前缀并保留未压缩尾部", async () => {
  const messages = buildLongHistory();
  let receivedCount = 0;
  const result = await compactSessionHistory(messages, {
    // 窗口刻意小于消息总量，确保 shouldCompact 命中。
    model: { contextWindow: 16_000 },
    summarizer: async (messagesToSummarize, previousSummary) => {
      receivedCount = messagesToSummarize.length;
      assert.equal(previousSummary, undefined);
      return "用户连续提供了 30 条上下文素材。";
    },
  });

  assert.equal(result.compacted, true);
  assert.ok(receivedCount > 0);
  assert.equal(result.messages[0].role, "compaction");
  assert.equal(result.messages[0].summary, "用户连续提供了 30 条上下文素材。");
  assert.equal(result.messages[0].summarizedMessageCount, receivedCount);
  assert.equal(result.messages.length, 1 + (30 - receivedCount));
  assert.equal(result.messageCountBefore, 30);
  assert.ok(result.tokensBefore > 0);
});

test("compactSessionHistory：摘要失败时告警并保存未压缩版本", async () => {
  const messages = buildLongHistory();
  const warnings = [];
  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 16_000 },
    summarizer: async () => {
      throw new Error("provider 401");
    },
    onWarn: (message) => warnings.push(message),
  });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /会话压缩失败/);
  assert.match(warnings[0], /provider 401/);
});

test("withSummaryFallback：摘要失败返回确定性兜底文本而不抛错", async () => {
  const warnings = [];
  const summarizer = withSummaryFallback(
    async () => {
      throw new Error("network down");
    },
    (message) => warnings.push(message),
  );

  const summary = await summarizer([longUserMessage(1)]);
  assert.match(summary, /自动兜底摘要/);
  assert.match(summary, /network down/);
  assert.match(summary, /第 1 条/);
  assert.equal(warnings.length, 1);
});

test("buildSummaryTranscript：超长时保留更靠近当前的消息", () => {
  const messages = [longUserMessage(1), longUserMessage(2), longUserMessage(3)];
  const transcript = buildSummaryTranscript(messages, 3_000);
  assert.ok(transcript.includes("第 3 条"));
  assert.equal(transcript.includes("第 1 条"), false);
});

test("buildFallbackSummary：包含失败原因与原始片段", () => {
  const summary = buildFallbackSummary([longUserMessage(9)], "timeout");
  assert.match(summary, /timeout/);
  assert.match(summary, /第 9 条/);
});

test("compactSessionHistory：超窗 assistant 经硬收敛后真正降到窗口以下（P1-1）", async () => {
  // 模拟一次真实大文件 read 后的场景：保留尾部只有一条超大 assistant，
  // 且它的 usage 仍报告 25100 token（压缩前上下文）。
  const longText = "长文本素材".repeat(20_000);
  const messages = [
    { role: "user", content: "读取并总结大文件", timestamp: 1 },
    assistantMessage(longText),
  ];

  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 20_000 },
    summarizer: async () => "用户要求读取并总结大文件。",
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages[0].role, "compaction");
  assert.ok(result.tokensAfter <= 20_000 - 4_000, `tokensAfter=${result.tokensAfter} 应 <= 16000`);
  assert.ok(result.tokensAfter < result.tokensBefore);
  assert.ok(result.truncatedMessages > 0, "应截断超大文本");
  assert.match(result.messages[1].content[0].text, /已截断以适配上下文窗口/);
});

test("compactSessionHistory：硬收敛只截断文本，不改 toolCall arguments（P1-1）", async () => {
  const toolArgs = { path: "src/index.ts", pattern: "x".repeat(20_000) };
  const hugeText = "工具输出".repeat(25_000);
  const messages = [
    { role: "user", content: "跑一次工具", timestamp: 1 },
    {
      ...assistantMessage("", 30_000, 2),
      content: [
        { type: "text", text: hugeText },
        { type: "toolCall", id: "call-1", name: "grep", arguments: toolArgs },
      ],
    },
  ];

  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 20_000 },
    summarizer: async () => "用户要求运行 grep。",
  });

  const assistant = result.messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  const toolCall = assistant.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall.arguments, toolArgs);
  assert.match(assistant.content.find((block) => block.type === "text").text, /已截断/);
});

test("compactSessionHistory：文本截断仍不够时丢弃最旧消息并保持 toolCall/toolResult 配对（P1-1）", async () => {
  const messages = [
    { role: "user", content: "旧问题", timestamp: 1 },
    {
      ...assistantMessage("", 5_000, 2),
      content: [
        {
          type: "toolCall",
          id: "call-big",
          name: "grep",
          arguments: { pattern: "y".repeat(80_000) },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-big",
      toolName: "grep",
      content: [{ type: "text", text: "匹配结果" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 2_000 },
    summarizer: async () => "旧问题摘要",
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "compaction");
  // toolCall 与它的 toolResult 必须一起被丢弃，不能留下孤立 toolResult。
  assert.equal(result.messages.some((message) => message.role === "toolResult"), false);
  assert.ok(result.droppedMessages >= 2);
});

test("compactSessionHistory：usage 锚点很小但内容超窗时仍触发压缩（D1）", async () => {
  // 复现运行期压缩后的落盘场景：最后一条 assistant 的 usage 只反映压缩后的 loop 副本（110），
  // 但 history 里仍保留两条 50KB ToolResult，内容估算约 25k token。
  const bigText = "x".repeat(50_000);
  const messages = [
    { role: "user", content: "读取两个大文件", timestamp: 1 },
    {
      ...assistantMessage("", 100, 2),
      content: [
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.txt" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "read",
      content: [{ type: "text", text: bigText }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "read",
      content: [{ type: "text", text: bigText }],
      isError: false,
      timestamp: 4,
    },
    // 运行期压缩后的最终回复：usage 很小，是旧逻辑漏判的锚点。
    assistantMessage("已完成。", 110, 5),
  ];

  let summarizeCalls = 0;
  const result = await compactSessionHistory(messages, {
    model: { contextWindow: 20_000 },
    summarizer: async () => {
      summarizeCalls += 1;
      return "用户读取了两个大文件。";
    },
  });

  assert.equal(summarizeCalls, 1, "内容超窗必须触发摘要压缩");
  assert.equal(result.compacted, true);
  assert.ok(result.tokensBefore > 20_000, `tokensBefore=${result.tokensBefore} 应按内容估算超过窗口`);
  assert.equal(result.messages[0].role, "compaction");
  assert.ok(
    result.tokensAfter <= 20_000 - 4_000,
    `tokensAfter=${result.tokensAfter} 应 <= 窗口阈值 16000`,
  );
  // 内容层面也必须真正下降，而不只是 usage 数字变化。
  const contentAfter = result.messages.reduce(
    (sum, message) => sum + Math.ceil((message.summary?.length ?? JSON.stringify(message.content).length) / 4),
    0,
  );
  assert.ok(contentAfter <= 20_000 - 4_000, `内容估算 ${contentAfter} 应 <= 16000`);
});

test("createLlmSummarizer：摘要响应 usage 通过 onUsage 计入会话（P1-2）", async () => {
  const usages = [];
  const summarizer = createLlmSummarizer({
    model: { contextWindow: 128_000, maxTokens: 8_192, id: "stub", provider: "deepseek" },
    apiKey: "stub-key",
    // 注入桩流：只验证 usage 回调，不发起真实请求。
    streamFn: () => ({
      result: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "这是摘要" }],
        usage: {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
          cost: { input: 0.0001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    }),
    onUsage: (usage) => usages.push(usage),
  });

  const summary = await summarizer([longUserMessage(1)]);
  assert.equal(summary, "这是摘要");
  assert.equal(usages.length, 1);
  assert.equal(usages[0].totalTokens, 110);
  assert.equal(usages[0].cost.total, 0.0001);
});

test("filterFailedAssistants：丢弃 error/aborted assistant，保留前置 user（P3-8）", () => {
  const messages = [
    { role: "user", content: "问题", timestamp: 1 },
    { ...assistantMessage("", 0, 2), stopReason: "error", errorMessage: "400" },
    { role: "user", content: "再问一次", timestamp: 3 },
    { ...assistantMessage("正常回复", 10, 4), stopReason: "aborted" },
    { ...assistantMessage("最终回复", 10, 5), stopReason: "stop" },
  ];

  const filtered = filterFailedAssistants(messages);
  assert.equal(filtered.length, 3);
  assert.deepEqual(
    filtered.map((message) => message.role),
    ["user", "user", "assistant"],
  );
  assert.equal(filtered[2].content[0].text, "最终回复");
});
