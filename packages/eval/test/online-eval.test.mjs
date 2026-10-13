import assert from "node:assert/strict";
import { test } from "node:test";
import { createShadowEvaluator, sampleAndEvaluate } from "../dist/index.js";

test("shadow evaluator produces 0~1 scores and is reproducible", async () => {
  const evaluator = createShadowEvaluator();
  const input = {
    caseId: "shadow-1",
    query: "特斯拉 2023 年交付量是多少？",
    answer: "特斯拉 2023 年交付 1808581 辆。",
    expectedText: "特斯拉 2023 年交付量为 1,808,581 辆。",
    contexts: ["特斯拉 2023 年交付 1808581 辆，同比增长 38%。"]
  };

  const first = await evaluator.evaluate(input);
  const second = await evaluator.evaluate(input);

  assert.ok(first.answerCorrectness >= 0 && first.answerCorrectness <= 1);
  assert.ok(first.faithfulness >= 0 && first.faithfulness <= 1);
  // 确定性 mock judge：相同输入两次分数必须一致（可复现）。
  assert.equal(first.answerCorrectness, second.answerCorrectness);
  assert.equal(first.faithfulness, second.faithfulness);
  // 影子评测仅观测：sampledAt 为合法 ISO 时间，且不写回任何状态。
  assert.ok(typeof first.sampledAt === "string" && !Number.isNaN(Date.parse(first.sampledAt)));
  assert.equal(first.caseId, "shadow-1");
});

test("sampleAndEvaluate runs all samples concurrently and returns matching length", async () => {
  const evaluator = createShadowEvaluator();
  const samples = [
    { caseId: "s-1", query: "苹果成立于哪一年？", answer: "苹果成立于 1976 年。", expectedText: "苹果公司成立于 1976 年。" },
    { caseId: "s-2", query: "伯克希尔 2022 净利润？", answer: "962 亿美元。", expectedText: "伯克希尔哈撒韦 2022 年净利润为 962 亿美元。" }
  ];

  const results = await sampleAndEvaluate(evaluator, samples);
  assert.equal(results.length, 2);
  assert.equal(results[0].caseId, "s-1");
  assert.equal(results[1].caseId, "s-2");
  for (const r of results) {
    assert.ok(r.answerCorrectness >= 0 && r.answerCorrectness <= 1);
    assert.ok(r.faithfulness >= 0 && r.faithfulness <= 1);
  }
});
