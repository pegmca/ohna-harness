import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  loadEvalDataset,
  runEvalCaseWithLoop,
  classifyFailure,
  matchTrajectory,
  extractToolTrajectory,
} from "../dist/index.js";

const datasetPath = resolve(process.cwd(), "../../datasets/eval-financial-v1.json");

test("matchTrajectory strict: extra actual tool → matched=false", () => {
  const expected = [{ toolName: "search_filings" }];
  const actual = [
    { seq: 1, toolName: "search_filings", args: {}, isError: false },
    { seq: 2, toolName: "generate_report", args: {}, isError: false },
  ];
  const result = matchTrajectory(expected, actual, "strict");
  assert.equal(result.matched, false);
  assert.deepEqual(result.extra, ["generate_report"]);
  assert.deepEqual(result.missing, []);
});

test("matchTrajectory subset: extra actual tool tolerated → matched=true", () => {
  const expected = [{ toolName: "search_filings" }];
  const actual = [
    { seq: 1, toolName: "search_filings", args: {}, isError: false },
    { seq: 2, toolName: "generate_report", args: {}, isError: false },
  ];
  const result = matchTrajectory(expected, actual, "subset");
  assert.equal(result.matched, true);
});

test("matchTrajectory: missing required arg → paramMismatches non-empty, matched=false", () => {
  const expected = [{ toolName: "search_filings", requiredArgs: ["query"] }];
  const actual = [{ seq: 1, toolName: "search_filings", args: {}, isError: false }];
  const result = matchTrajectory(expected, actual, "strict");
  assert.equal(result.matched, false);
  assert.deepEqual(result.paramMismatches, [{ toolName: "search_filings", missingArgs: ["query"] }]);
});

test("classifyFailure: fail-001 → hallucination", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.id === "fail-001");
  const run = await runEvalCaseWithLoop(item);
  assert.equal(classifyFailure({ evidence: run.evidence, trajectory: run.trajectory, item }), "hallucination");
});

test("classifyFailure: fail-002 → retrieval_missing", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.id === "fail-002");
  const run = await runEvalCaseWithLoop(item);
  assert.equal(classifyFailure({ evidence: run.evidence, trajectory: run.trajectory, item }), "retrieval_missing");
});

test("classifyFailure: fail-003 → workflow_incomplete", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.id === "fail-003");
  const run = await runEvalCaseWithLoop(item);
  assert.equal(classifyFailure({ evidence: run.evidence, trajectory: run.trajectory, item }), "workflow_incomplete");
});

test("classifyFailure: normal rag fixture → none", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.mode === "rag" && c.fixture.retrievedChunks.length > 0 && c.fixture.ok);
  const run = await runEvalCaseWithLoop(item);
  assert.equal(classifyFailure({ evidence: run.evidence, trajectory: run.trajectory, item }), "none");
});

test("extractToolTrajectory: ordering, isError mapping, missing-end default", () => {
  const events = [
    { seq: 1, type: "tool_execution_start", payload: { toolCallId: "c1", toolName: "search_filings", args: { query: "x" } } },
    { seq: 2, type: "tool_execution_end", payload: { toolCallId: "c1", toolName: "search_filings", result: { content: [{ type: "text", text: "hello world" }] }, isError: false } },
    { seq: 3, type: "tool_execution_start", payload: { toolCallId: "c2", toolName: "generate_report", args: { subject: "s" } } },
    { seq: 4, type: "tool_execution_end", payload: { toolCallId: "c2", toolName: "generate_report", result: {}, isError: true } },
    { seq: 5, type: "tool_execution_start", payload: { toolCallId: "c3", toolName: "search_filings", args: { query: "y" } } },
    // c3 无对应 end：防御式 isError 默认 false
  ];
  const trajectory = extractToolTrajectory(events);
  assert.equal(trajectory.length, 3);
  assert.deepEqual(trajectory.map((s) => s.seq), [1, 3, 5]);
  assert.deepEqual(trajectory.map((s) => s.toolName), ["search_filings", "generate_report", "search_filings"]);
  assert.deepEqual(trajectory.map((s) => s.isError), [false, true, false]);
  assert.equal(trajectory[0].resultSummary, "hello world");
  assert.deepEqual(trajectory[0].args, { query: "x" });
});
