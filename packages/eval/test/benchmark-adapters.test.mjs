import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMockGaiaAdapter,
  createMockTauBenchAdapter,
  benchmarkCaseToUnified,
  benchmarkDatasetToEvalDataset
} from "../dist/index.js";

test("mock gaia adapter returns >=3 cases with gaia- prefix", async () => {
  const cases = await createMockGaiaAdapter().loadCases();
  assert.ok(cases.length >= 3, `gaia 用例数应 >=3，实际 ${cases.length}`);
  for (const c of cases) {
    assert.ok(c.id.startsWith("gaia-"), `${c.id} 应以 gaia- 前缀`);
    assert.equal(c.mode, "chat");
    assert.ok(Array.isArray(c.expectedFacts) && c.expectedFacts.length > 0);
  }
});

test("mock tau adapter returns >=3 cases with tau- prefix", async () => {
  const cases = await createMockTauBenchAdapter().loadCases();
  assert.ok(cases.length >= 3, `tau 用例数应 >=3，实际 ${cases.length}`);
  for (const c of cases) {
    assert.ok(c.id.startsWith("tau-"), `${c.id} 应以 tau- 前缀`);
    assert.ok(c.mode === "rag" || c.mode === "report");
    assert.ok(Array.isArray(c.expectedFacts) && c.expectedFacts.length > 0);
  }
});

test("benchmarkCaseToUnified produces a valid UnifiedEvalCase", async () => {
  const [c] = await createMockGaiaAdapter().loadCases();
  const unified = benchmarkCaseToUnified(c, "gaia-mock-v1");

  assert.equal(unified.id, c.id);
  assert.equal(unified.mode, c.mode);
  assert.equal(unified.query, c.query);
  assert.equal(unified.fixture.ok, true);
  assert.equal(unified.fixture.answer, c.expectedAnswer);
  assert.deepEqual(unified.fixture.citations, []);
  assert.deepEqual(unified.fixture.retrievedChunks, []);
  assert.deepEqual(unified.fixture.workflow, []);
  assert.deepEqual(unified.fixture.sections, []);
  assert.equal(unified.fixture.exportStatus, undefined);
  assert.equal(unified.fixture.latencyMs, 0);
  assert.equal(unified.fixture.traceId, `bench-${c.id}`);
  assert.equal(unified.fixture.requestId, `bench-req-${c.id}`);
  assert.deepEqual(unified.tags, c.tags);
  assert.equal(unified.expectedFacts.length, c.expectedFacts.length);
});

test("benchmarkDatasetToEvalDataset wraps adapter cases into EvalDataset", async () => {
  const adapter = createMockTauBenchAdapter();
  const dataset = await benchmarkDatasetToEvalDataset(adapter, 42);

  assert.equal(dataset.schemaVersion, "1.0.0");
  assert.equal(dataset.datasetVersion, adapter.id);
  assert.equal(dataset.seed, 42);
  const sourceCases = await adapter.loadCases();
  assert.equal(dataset.cases.length, sourceCases.length);
  // 小样本（3 条）也能直接喂给 runLoopEval（loadEvalDataset 才校验 30~50）。
  assert.ok(dataset.cases.every((c) => c.fixture.ok === true));
});
