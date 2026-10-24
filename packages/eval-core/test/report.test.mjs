import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown, writeReports } from "../dist/index.js";

const sample = {
  target: "finance-api",
  dataset: "rag-v1",
  createdAt: "2026-10-24T00:00:00Z",
  metrics: [
    { name: "retrievalHitRate", value: 0.9, unit: "ratio", applicable: true },
    { name: "citationCoverage", value: 1, unit: "ratio", applicable: false }, // G5：不计入
  ],
  cases: [
    { id: "c1", passed: true },
    { id: "c2", passed: false, failedMetrics: ["retrievalHitRate"], failedTaxonomy: "retrieval_missing" },
  ],
  summary: "首次基线",
};

test("renderMarkdown 仅渲染 applicable 指标（G5）", () => {
  const md = renderMarkdown(sample, []);
  assert.match(md, /retrievalHitRate/);
  assert.ok(!md.includes("citationCoverage"), "applicable=false 的指标不应出现在指标表");
  assert.match(md, /通过率/);
  assert.match(md, /失败 Case 归因/);
});

test("renderMarkdown 渲染 baseline diff 表", () => {
  const md = renderMarkdown(sample, [
    { metric: "retrievalHitRate", current: 0.9, baseline: 0.85, delta: 0.05, status: "improvement" },
  ]);
  assert.match(md, /Baseline Diff/);
  assert.match(md, /improvement/);
});

test("writeReports 落盘 report.json 与 report.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-core-"));
  try {
    await writeReports(sample, dir);
    const json = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    assert.equal(json.target, "finance-api");
    const md = await readFile(join(dir, "report.md"), "utf8");
    assert.match(md, /评测报告/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
