import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlmJudge } from "../dist/judge.js";

/**
 * 用给定的 choices[0].message.content 临时替换全局 fetch，模拟 bridge chat 响应。
 * @param {string} content 模型返回的文本内容。
 * @returns {() => void} 还原全局 fetch 的函数。
 */
function mockFetchWithContent(content) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  });
  return () => {
    globalThis.fetch = original;
  };
}

test("judgeFaithfulness parses score and reason from JSON", async () => {
  const restore = mockFetchWithContent(JSON.stringify({ score: 0.92, reason: "答案每个论断都有上下文支撑" }));
  try {
    const judge = createLlmJudge({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await judge.judgeFaithfulness("净利润多少？", "净利润同比增长。", ["净利润同比增长至360亿元"]);

    assert.equal(result.score, 0.92);
    assert.match(result.reason, /上下文支撑/);
  } finally {
    restore();
  }
});

test("judgeContextRecall parses score from JSON", async () => {
  const restore = mockFetchWithContent(JSON.stringify({ score: 0.8, reason: "期望证据基本覆盖" }));
  try {
    const judge = createLlmJudge({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await judge.judgeContextRecall(["期望证据文本"], ["实际检索文本"]);

    assert.equal(result.score, 0.8);
  } finally {
    restore();
  }
});

test("judge tolerates fenced JSON and stray text", async () => {
  const restore = mockFetchWithContent("```json\n" + JSON.stringify({ score: 0.7, reason: "带围栏的 JSON" }) + "\n```");
  try {
    const judge = createLlmJudge({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await judge.judgeFaithfulness("问题", "答案", ["上下文"]);

    assert.equal(result.score, 0.7);
    assert.match(result.reason, /围栏/);
  } finally {
    restore();
  }
});

test("judge returns neutral score without throwing when bridge env is missing", async () => {
  const baseUrl = process.env.AIAGENT_LLM_BASE_URL_BRIDGE_AI;
  const apiKey = process.env.AIAGENT_LLM_API_KEY_BRIDGE_AI;
  delete process.env.AIAGENT_LLM_BASE_URL_BRIDGE_AI;
  delete process.env.AIAGENT_LLM_API_KEY_BRIDGE_AI;

  try {
    const judge = createLlmJudge();
    const faithfulness = await judge.judgeFaithfulness("问题", "答案", ["上下文"]);
    const recall = await judge.judgeContextRecall(["期望"], ["检索"]);

    assert.equal(faithfulness.score, 0.5);
    assert.equal(recall.score, 0.5);
    assert.match(faithfulness.reason, /bridge env 未配置|中性分/);
  } finally {
    if (baseUrl !== undefined) process.env.AIAGENT_LLM_BASE_URL_BRIDGE_AI = baseUrl;
    if (apiKey !== undefined) process.env.AIAGENT_LLM_API_KEY_BRIDGE_AI = apiKey;
  }
});

test("judge downgrades to neutral score on fetch failure without throwing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const judge = createLlmJudge({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await judge.judgeFaithfulness("问题", "答案", ["上下文"]);

    assert.equal(result.score, 0.5);
    assert.match(result.reason, /降级中性分|调用失败/);
  } finally {
    globalThis.fetch = original;
  }
});
