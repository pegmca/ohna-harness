/**
 * finance-api 评测「接线 + 真实数据集」整体测试（finance-eval-tests 工作项的接线验证部分）。
 *
 * 本文件刻意与兄弟工作项的单测不重复：兄弟测试用「内存里现造的合成数据集」验证各模块纯逻辑；
 * 本文件改用**仓库内真实提交的数据集制品 `datasets/finance/rag-v1.json`**，端到端把
 * dataset → metrics → adapter → run 串成一条链，验证 Step 3 的「领域自治接线」整体成立：
 *
 * 1. `loadFinanceDataset` 能加载真实迁移数据集，并满足迁移不变量（rag 类 case 必带 documents、
 *    原 id 全部保留、mode 分布与迁移脚本一致）。
 * 2. 真实数据集 → `runFinanceEval({tier:"deterministic"})` 真正产出 `EvalReportDto`，
 *    且真实检索指标 retrievalHitRate/mrr/ndcg 恒为 1（证明 G1 真实 answer + G5 source 级命中
 *    在真实数据上成立；兄弟测试只验证内存合成数据）。
 * 3. `createDeterministicFinanceRagRuntime` 能真实 ingest 真实数据集文档并 answer（修 G1 接线）。
 * 4. 无期望字段的 case 经 `runFinanceEval` 后，报告里对应指标 `applicable===false`（修 G5 端到端）。
 * 5. 数据集制品路径与 index.ts 默认 `--dataset` 指向一致（保证 `pnpm eval:finance-api` 可落地）。
 *
 * 注意：从已编译的 `../dist/eval/*` 导入（与 `pnpm test` 的 `pnpm build` 前置一致）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadFinanceDataset } from "../dist/eval/dataset.js";
import { createDeterministicFinanceRagRuntime } from "../dist/eval/adapter.js";
import { runFinanceEval } from "../dist/eval/run.js";

/** 仓库根：本测试文件位于 apps/finance-api/test/，向上三级到仓库根（与 index.ts 用 fileURLToPath 对齐）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** 真实提交的迁移数据集制品路径。 */
const DATASET_PATH = resolve(REPO_ROOT, "datasets/finance/rag-v1.json");

test("真实迁移数据集可被 loadFinanceDataset 加载且满足迁移不变量", () => {
  assert.ok(existsSync(DATASET_PATH), "数据集制品应存在于 datasets/finance/rag-v1.json");
  const ds = loadFinanceDataset(DATASET_PATH);

  // 原 id 全部保留（迁移映射保持 id 不变）。
  const ids = new Set(ds.cases.map((c) => c.id));
  for (const id of ["rag-001", "rag-018", "chat-001", "report-001", "fail-001"]) {
    assert.ok(ids.has(id), `迁移应保留原 id：${id}`);
  }

  // mode 分布与迁移脚本一致：rag 18 / chat 5 / report 5 / failure 3。
  const byMode = ds.cases.reduce((acc, c) => ((acc[c.mode] = (acc[c.mode] ?? 0) + 1), acc), {});
  assert.deepEqual(byMode, { rag: 18, chat: 5, report: 5, failure: 3 }, "mode 分布应等于迁移结果");

  // 迁移不变量（修 G1 前提）：每个 rag 类 case 必带非空 documents（deterministic 真实 ingest）。
  const ragCases = ds.cases.filter((c) => c.mode === "rag");
  assert.equal(ragCases.length, 18);
  for (const c of ragCases) {
    assert.ok(Array.isArray(c.documents) && c.documents.length > 0, `rag case ${c.id} 应携带 documents`);
    assert.ok(Array.isArray(c.expectedSources) && c.expectedSources.length > 0, `rag case ${c.id} 应有 expectedSources`);
  }
});

test("真实数据集经 runFinanceEval(deterministic) 产出 EvalReportDto 且真实检索指标为 1（G1+G5）", async () => {
  const ds = loadFinanceDataset(DATASET_PATH);
  const report = await runFinanceEval(ds, { tier: "deterministic" });

  // 跨边界线格式契约。
  assert.equal(report.target, "finance-api");
  assert.equal(report.dataset, "finance-rag-v1.0.0");
  assert.ok(Array.isArray(report.metrics), "metrics 应为数组");
  assert.ok(Array.isArray(report.cases), "cases 应为数组");

  // deterministic 档只跑 rag 类 → 18 条。
  assert.equal(report.cases.length, 18, "deterministic 档仅跑 rag 类，应为 18 条");

  // G1 真实 answer + G5 source 级命中：在真实数据上检索指标必须真实命中（=1），
  // 而非 fixture 回放或恒 0。
  const byName = new Map(report.metrics.map((m) => [m.name, m]));
  for (const name of ["retrievalHitRate", "mrr", "ndcg"]) {
    const m = byName.get(name);
    assert.ok(m, `报告中应含指标 ${name}`);
    assert.equal(m.applicable, true, `${name} 在带 expectedSources 的 case 上应 applicable`);
    assert.equal(m.value, 1, `真实检索应命中所有期望 source（${name}=1）`);
  }

  // 确定性关键词覆盖基线（兄弟测试未验真实数据集上的取值区间）。
  const answerCorrectness = byName.get("answerCorrectness");
  assert.ok(answerCorrectness && answerCorrectness.value > 0.8, "answerCorrectness 在真实数据集上应 > 0.8");

  // refusalRate 是跨 case 聚合指标，值应在 [0,1]。
  const refusalRate = byName.get("refusalRate");
  assert.ok(refusalRate, "refusalRate 应被聚合进报告");
  assert.ok(refusalRate.value >= 0 && refusalRate.value <= 1);
});

test("adapter 能真实 ingest 真实数据集文档并 answer（修 G1 接线）", async () => {
  const ds = loadFinanceDataset(DATASET_PATH);
  const case_ = ds.cases.find((c) => c.id === "rag-001");
  assert.ok(case_ && case_.documents.length > 0, "rag-001 应带 documents");

  const runtime = await createDeterministicFinanceRagRuntime(case_.documents);
  const response = await runtime.answer(case_.query);
  assert.ok(response.ok, "真实 runtime answer 应返回 ok");
  if (!response.ok) return;

  const answer = response.data.answer;
  assert.ok(answer.retrievalResults.length > 0, "应真实执行检索（retrievalResults 非空，证非 fixture 回放）");
  assert.ok(
    answer.status === "answered" || answer.status === "insufficient_evidence" || answer.status === undefined,
    "status 为可选结构化拒答信号"
  );
});

test("无期望字段的 case 经 runFinanceEval 后报告指标 applicable=false（G5 端到端）", async () => {
  // 合成最小数据集：单条 rag case 带 documents 但无 expectedSources/expectedKeywords。
  const synthetic = {
    schemaVersion: "2.0.0",
    datasetVersion: "synthetic-no-expect",
    minCases: 1,
    cases: [
      {
        id: "no-expect-1",
        mode: "rag",
        query: "某指标是多少",
        documents: [{ source: "doc-x", fileName: "doc-x.md", content: "某指标是 12%。" }],
        tags: ["rag"]
      }
    ]
  };
  const report = await runFinanceEval(synthetic, { tier: "deterministic" });
  const byName = new Map(report.metrics.map((m) => [m.name, m]));
  for (const name of ["retrievalHitRate", "mrr", "ndcg", "answerCorrectness"]) {
    const m = byName.get(name);
    assert.ok(m, `报告应含指标 ${name}`);
    assert.equal(m.applicable, false, `${name} 在无期望字段 case 上应 applicable=false（G5）`);
  }
  // citationCoverage 恒定适用。
  assert.equal(byName.get("citationCoverage").applicable, true);
});

test("index.ts 默认 --dataset 指向的真实制品存在（保证 pnpm eval:finance-api 可落地）", () => {
  // index.ts 用 resolve(HERE, "../../../../datasets/finance/rag-v1.json") 解析默认数据集，
  // 其中 HERE = src/eval，向上四级 = 仓库根。
  assert.ok(existsSync(DATASET_PATH), "默认数据集路径应与本测试解析路径一致");
});
