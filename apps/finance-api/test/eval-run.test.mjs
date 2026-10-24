/**
 * finance-api eval 执行器测试（run.ts 工作项）。
 *
 * 验证：deterministic 档真实调用 DataSourceRuntime.answer()（修 G1）、产出 EvalReportDto、
 * 无期望字段的指标标记 applicable（修 G5）。不依赖外部 provider。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runFinanceEval } from "../dist/eval/run.js";

/** 构造最小可检索的金融评测数据集（2 条 rag case 共享同一 source 文档）。 */
function buildDataset() {
  const doc = { source: "annual", fileName: "annual.md", content: "2024年不良率1.05%。2024年净利润397亿元人民币。2024年ROE为10.5%。" };
  return {
    schemaVersion: "2.0.0",
    datasetVersion: "finance-rag-v1.0.0",
    minCases: 1,
    cases: [
      {
        id: "t-rag-1",
        mode: "rag",
        query: "平安银行不良率",
        documents: [doc],
        expectedSources: ["annual"],
        expectedKeywords: ["不良率"],
        goldEvidence: ["2024年不良率1.05%"],
        minCitations: 1,
        tags: ["rag"]
      },
      {
        id: "t-rag-2",
        mode: "rag",
        query: "平安银行净利润",
        documents: [doc],
        expectedSources: ["annual"],
        expectedKeywords: ["净利润"],
        goldEvidence: ["2024年净利润397亿元"],
        minCitations: 1,
        tags: ["rag"]
      }
    ]
  };
}

test("deterministic 档真实调用 answer 并产出 EvalReportDto", async () => {
  const report = await runFinanceEval(buildDataset(), { tier: "deterministic" });
  assert.equal(report.target, "finance-api");
  assert.equal(report.dataset, "finance-rag-v1.0.0");
  assert.ok(Array.isArray(report.metrics));
  assert.equal(report.cases.length, 2);
});

test("retrievalHitRate 真实命中（source 级）且 applicable", async () => {
  const report = await runFinanceEval(buildDataset(), { tier: "deterministic" });
  const hit = report.metrics.find((m) => m.name === "retrievalHitRate");
  assert.ok(hit, "retrievalHitRate 应存在");
  assert.equal(hit.applicable, true);
  assert.equal(hit.value, 1, "真实检索应命中 annual source");
});

test("chat 类 case 不参与 deterministic 档（仅跑 rag）", async () => {
  const ds = buildDataset();
  ds.cases.push({ id: "t-chat-1", mode: "chat", query: "你好", documents: [], tags: ["chat"] });
  const report = await runFinanceEval(ds, { tier: "deterministic" });
  // 只跑 rag 类 → 2 条，chat 不进报告。
  assert.equal(report.cases.length, 2);
});

test("非 deterministic 档位尚未实现应抛错", async () => {
  await assert.rejects(() => runFinanceEval(buildDataset(), { tier: "live" }), /尚未在 finance-api 实现/);
});

test("refusalRate 作为跨 case 聚合指标并入报告", async () => {
  const report = await runFinanceEval(buildDataset(), { tier: "deterministic" });
  const refusal = report.metrics.find((m) => m.name === "refusalRate");
  assert.ok(refusal, "refusalRate 应被聚合进报告");
  assert.ok(refusal.value >= 0 && refusal.value <= 1);
});
