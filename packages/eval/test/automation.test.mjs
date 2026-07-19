import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createBaseline, loadEvalDataset, renderMarkdownReport, runAutomationEval, writeReports } from "../dist/index.js";

const datasetPath = resolve(process.cwd(), "../../datasets/eval-financial-v1.json");

test("versioned dataset covers 30-50 Chat/RAG/Report/failure cases", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  assert.ok(dataset.cases.length >= 30 && dataset.cases.length <= 50);
  assert.deepEqual(new Set(dataset.cases.map((item) => item.mode)), new Set(["chat", "rag", "report", "failure"]));
  assert.ok(dataset.cases.filter((item) => item.mode === "failure").length >= 3);
});

test("metrics jointly validate financial value, unit, currency, period and source", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const report = runAutomationEval(dataset);
  const wrongFact = report.results.find((item) => item.caseId === "fail-001");
  assert.equal(wrongFact.metrics.financialAccuracy, 0);
  assert.ok(report.metrics.financialAccuracy > 0 && report.metrics.financialAccuracy < 1);
});

test("JSON and Markdown reports contain identical case count and required metrics", async () => {
  const dataset = await loadEvalDataset(datasetPath); const report = runAutomationEval(dataset);
  const dir = await mkdtemp(join(tmpdir(), "aiagent-eval-")); const json = join(dir, "report.json"); const md = join(dir, "report.md");
  await writeReports(report, json, md); const parsed = JSON.parse(await readFile(json, "utf8")); const markdown = await readFile(md, "utf8");
  assert.equal(parsed.results.length, dataset.cases.length);
  assert.equal((markdown.match(/^\| (?:rag|chat|report|fail)-/gm) ?? []).length, dataset.cases.length);
  for (const name of ["citationCoverage", "financialAccuracy", "sourceGroundedness", "successRate", "averageLatencyMs", "p95LatencyMs"]) assert.match(markdown, new RegExp(name));
  assert.ok(report.failures.length >= 3); assert.match(markdown, /根因:/); assert.match(markdown, /Trace \/ request:/);
});

test("baseline diff detects threshold regression and baseline creation records config", async () => {
  const dataset = await loadEvalDataset(datasetPath); const first = runAutomationEval(dataset); const baseline = createBaseline(first, dataset);
  const degraded = structuredClone(dataset); degraded.cases[0].fixture.citations = [];
  const report = runAutomationEval(degraded, baseline, { ...baseline.config.thresholds, citationCoverage: 0.99 });
  assert.ok(report.diff.some((item) => item.metric === "citationCoverage" && item.delta < 0));
  assert.ok(report.regressionReasons.some((reason) => reason.includes("citationCoverage")));
  assert.equal(baseline.config.strategy, "deterministic_fixture");
});

test("Markdown renders current-vs-baseline values and per-case failures", async () => {
  const dataset = await loadEvalDataset(datasetPath); const initial = runAutomationEval(dataset); const baseline = createBaseline(initial, dataset); const report = runAutomationEval(dataset, baseline);
  const markdown = renderMarkdownReport(report);
  assert.match(markdown, /Baseline/); assert.match(markdown, /fail-001/); assert.equal(report.regressionReasons.length, 0);
});
