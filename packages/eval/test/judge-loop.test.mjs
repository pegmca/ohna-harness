import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLlmJudge } from "../dist/judge-loop.js";

test("mock judge answerCorrectness 确定性且高重叠得高分", async () => {
  const judge = createLoopLlmJudge();
  const a = await judge.judgeAnswerCorrectness("q", "净利润 同比增长", "净利润 同比增长");
  const b = await judge.judgeAnswerCorrectness("q", "净利润 同比增长", "净利润 同比增长");
  assert.equal(a.score, b.score, "分数应可复现（确定性）");
  assert.equal(a.score, 1);
  assert.match(a.reason, /确定性 mock/);
});

test("mock judge answerCorrectness 低重叠得低分", async () => {
  const judge = createLoopLlmJudge();
  const high = await judge.judgeAnswerCorrectness("q", "苹果 香蕉 橙子", "苹果 香蕉 橙子");
  const low = await judge.judgeAnswerCorrectness("q", "苹果 香蕉 橙子", "西瓜 葡萄 芒果");
  assert.ok(low.score < high.score);
  assert.equal(low.score, 0);
  assert.equal(high.score, 1);
});

test("mock judge faithfulness 无上下文返回中性分", async () => {
  const judge = createLoopLlmJudge();
  const r = await judge.judgeFaithfulness("某答案文本", []);
  assert.equal(r.score, 0.5);
  assert.match(r.reason, /中性分/);
});

test("mock judge faithfulness 上下文覆盖答案词元得分更高", async () => {
  const judge = createLoopLlmJudge();
  const covered = await judge.judgeFaithfulness("净利润 同比增长", ["净利润 同比增长 至 360 亿元"]);
  const uncovered = await judge.judgeFaithfulness("净利润 同比增长", ["天气 晴朗"]);
  assert.ok(covered.score > uncovered.score);
  assert.equal(uncovered.score, 0);
  assert.equal(covered.score, 1);
});

test("mock judge 不发起网络请求（无 key），返回结构化结果", async () => {
  const judge = createLoopLlmJudge();
  const r = await judge.judgeAnswerCorrectness("q", "答案", "参考");
  assert.equal(typeof r.score, "number");
  assert.equal(typeof r.reason, "string");
});

test("judge 在真实模式失败时降级为中性分而不抛出", async () => {
  // 强制进入真实模式（有 key），但让 fetch 抛错，验证降级。
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const judge = createLoopLlmJudge({ baseUrl: "https://bridge.example.com/v1", apiKey: "k", model: "m" });
    const r = await judge.judgeFaithfulness("答案", ["上下文"]);
    assert.equal(r.score, 0.5);
    assert.match(r.reason, /降级中性分|调用失败/);
  } finally {
    globalThis.fetch = original;
  }
});
