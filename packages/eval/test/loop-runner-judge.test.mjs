import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadEvalDataset, runLoopEval } from "../dist/index.js";
import { createDeterministicMockLoopLlmJudge } from "../dist/testing.js";

const datasetPath = resolve(process.cwd(), "../../datasets/eval-financial-v1.json");

test("loop eval 不传 judge 时逐条 metrics 不含 llm 校准项（零回归）", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const report = await runLoopEval(dataset);
  for (const result of report.results) {
    assert.equal("llmAnswerCorrectness" in result.metrics, false);
    assert.equal("llmFaithfulness" in result.metrics, false);
  }
  // 聚合指标口径不变（仍为 7 确定性项 + 2 latency）。
  assert.equal("llmAnswerCorrectness" in report.metrics, false);
  assert.equal("llmFaithfulness" in report.metrics, false);
  assert.equal(report.run.llmJudge, false);
});

test("loop eval 传入 mock judge 时追加 llm 校准项且不影响门禁与聚合", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const noJudge = await runLoopEval(dataset);
  const judge = createDeterministicMockLoopLlmJudge(); // 显式注入确定性 mock 测试替身
  const withJudge = await runLoopEval(dataset, { judge });

  assert.equal(withJudge.results.length, noJudge.results.length);
  for (let i = 0; i < withJudge.results.length; i += 1) {
    const r = withJudge.results[i];
    const base = noJudge.results[i];
    assert.equal("llmAnswerCorrectness" in r.metrics, true);
    assert.equal("llmFaithfulness" in r.metrics, true);
    assert.equal(typeof r.metrics.llmAnswerCorrectness, "number");
    assert.equal(typeof r.metrics.llmFaithfulness, "number");
    // judge 校准信号不计入门禁：passed 必须来自确定性指标，且与无 judge 时逐条一致。
    assert.equal(r.passed, base.passed, `passed 应与无 judge 时一致: ${r.caseId}`);
  }

  // judge 指标不进入 AutomationMetrics 聚合口径：聚合 metrics 不应含任何 llm* 键。
  const llmAggKeys = Object.keys(withJudge.metrics).filter((k) => k.startsWith("llm"));
  assert.equal(llmAggKeys.length, 0, `聚合 metrics 不应含 llm 键: ${llmAggKeys.join(",")}`);

  // 7 项确定性指标与无 judge 时完全一致（剔除实时 latency 后比较，避免 wall-clock 抖动）。
  const deterministicKeys = [
    "citationCoverage",
    "financialAccuracy",
    "sourceGroundedness",
    "successRate",
    "workflowCompletion",
    "reportSectionCoverage",
    "exportStatusRate"
  ];
  const pickDeterministic = (metrics) =>
    Object.fromEntries(deterministicKeys.map((k) => [k, metrics[k]]));
  assert.deepEqual(pickDeterministic(withJudge.metrics), pickDeterministic(noJudge.metrics));

  // 逐条 passed 与无 judge 时完全一致（门禁口径零回归）。
  assert.deepEqual(
    withJudge.results.map((r) => r.passed),
    noJudge.results.map((r) => r.passed)
  );
  assert.deepEqual(withJudge.regressionReasons, noJudge.regressionReasons);
  assert.equal(withJudge.run.llmJudge, true);
});
