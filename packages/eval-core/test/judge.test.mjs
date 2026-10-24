import assert from "node:assert/strict";
import test from "node:test";
import {
  NEUTRAL_SCORE,
  parseJudgeJson,
  roundScore,
  majorityVote,
  sampleAndAverage,
} from "../dist/index.js";

test("roundScore 钳制到 [0,1] 并保留三位小数", () => {
  assert.equal(roundScore(1.23456), 1.0);
  assert.equal(roundScore(-0.5), 0);
  assert.equal(roundScore(2), 1);
  assert.equal(roundScore(NaN), NEUTRAL_SCORE);
  assert.equal(roundScore(0.12345), 0.123);
});

test("parseJudgeJson 解析裸 JSON", () => {
  const parsed = parseJudgeJson('{"score":0.8,"reason":"ok"}');
  assert.deepEqual(parsed, { score: 0.8, reason: "ok" });
});

test("parseJudgeJson 支持 ```json 围栏", () => {
  const text = "```json\n{\"score\": 0.7}\n```";
  const parsed = parseJudgeJson(text);
  assert.deepEqual(parsed, { score: 0.7 });
});

test("parseJudgeJson 抽取散落对象", () => {
  const text = "思考：… 最终 {\"score\":0.6,\"reason\":\"partial\"} 结束。";
  const parsed = parseJudgeJson(text);
  assert.deepEqual(parsed, { score: 0.6, reason: "partial" });
});

test("parseJudgeJson 空文本 / 无对象返回 null", () => {
  assert.equal(parseJudgeJson(""), null);
  assert.equal(parseJudgeJson("no json here"), null);
});

test("majorityVote 取均值并钳制，空数组回退 fallback", () => {
  assert.equal(majorityVote([0.5, 0.7, 0.9], NEUTRAL_SCORE), 0.7);
  assert.equal(majorityVote([], NEUTRAL_SCORE), NEUTRAL_SCORE);
});

test("sampleAndAverage 多次采样取均 + 失败降级中性分", async () => {
  let calls = 0;
  const callModel = async () => {
    calls += 1;
    return JSON.stringify({ score: 0.6 + calls * 0.1, reason: `r${calls}` });
  };
  const out = await sampleAndAverage(callModel, "sys", "user", 3);
  // (0.7 + 0.8 + 0.9) / 3 = 0.8
  assert.equal(out.score, 0.8);
  assert.equal(out.reason, "r1");
});

test("sampleAndAverage 调用失败时降级中性分并带 reason", async () => {
  const callModel = async () => {
    throw new Error("network down");
  };
  const out = await sampleAndAverage(callModel, "sys", "user", 2);
  assert.equal(out.score, NEUTRAL_SCORE);
  assert.match(out.reason, /降级中性分/);
});

test("sampleAndAverage 解析不出分数时用中性分", async () => {
  const callModel = async () => "完全不是 JSON";
  const out = await sampleAndAverage(callModel, "sys", "user", 2);
  assert.equal(out.score, NEUTRAL_SCORE);
});
