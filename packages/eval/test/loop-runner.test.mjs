import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import {
  loadEvalDataset,
  runAutomationEval,
  runEvalCaseWithLoop,
  runLoopEval,
  LOOP_EVAL_BUDGETS
} from "../dist/index.js";

const datasetPath = resolve(process.cwd(), "../../datasets/eval-financial-v1.json");

/** 旧体系已删除的事件名（06 映射表）：断言零残留。 */
const REMOVED_EVENT_TYPES = [
  "intent_routed",
  "report_plan",
  "report_skill_activation",
  "approval",
  "agent_step",
  "model_call",
  "tool_call",
  "final_response"
];

/** 无限调用工具的 mock streamFn：验证预算双层截停。 */
function createLoopingStreamFn() {
  return () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "loop_call", name: "search_filings", arguments: { query: "x" } }],
      api: "openai-completions",
      provider: "mock",
      model: "eval-mock",
      usage: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now()
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
    });
    return stream;
  };
}

test("dataset fixtures carry no removed legacy event fields", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  for (const item of dataset.cases) {
    for (const key of Object.keys(item.fixture)) {
      assert.ok(!REMOVED_EVENT_TYPES.includes(key), `${item.id} fixture 残留旧字段 ${key}`);
    }
  }
});

test("loop eval metrics equal deterministic fixture scoring (no regression vs baseline)", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const fixtureReport = runAutomationEval(dataset);
  const loopReport = await runLoopEval(dataset);
  // 延迟指标由真实 loop 实测，不与录制值对比；其余七项指标必须逐项相等。
  for (const key of ["citationCoverage", "financialAccuracy", "sourceGroundedness", "successRate", "workflowCompletion", "reportSectionCoverage", "exportStatusRate"]) {
    assert.equal(loopReport.metrics[key], fixtureReport.metrics[key], `${key} 与 fixture 打分不一致`);
  }
  assert.equal(loopReport.run.strategy, "deterministic_fixture");
  assert.equal(loopReport.run.llmJudge, false);
});

test("rag case emits mapped loop events and retrieval, no removed event types", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.mode === "rag" && c.fixture.retrievedChunks.length > 0);
  const run = await runEvalCaseWithLoop(item);
  const types = run.events.map((event) => event.type);

  for (const expected of ["agent_start", "turn_start", "message_end", "tool_execution_start", "tool_execution_end", "retrieval", "agent_end"]) {
    assert.ok(types.includes(expected), `缺少事件 ${expected}`);
  }
  for (const removed of REMOVED_EVENT_TYPES) {
    assert.ok(!types.includes(removed), `出现已删除事件 ${removed}`);
  }
  // tool_call → tool_execution_start/end 一对一映射。
  const starts = types.filter((t) => t === "tool_execution_start").length;
  const ends = types.filter((t) => t === "tool_execution_end").length;
  assert.equal(starts, ends);
  assert.equal(run.events.find((e) => e.type === "tool_execution_start").payload.toolName, "search_filings");
  // 证据来自 run_events 投影，且与 fixture 种子一致。
  assert.equal(run.evidence.answer, item.fixture.answer);
  assert.deepEqual(run.evidence.retrievedChunks, item.fixture.retrievedChunks);
  assert.equal(run.evidence.ok, true);
});

test("report case emits workflow_node per fixture node plus pdf_export", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.mode === "report");
  const run = await runEvalCaseWithLoop(item);
  const types = run.events.map((event) => event.type);

  const workflowNodes = run.events.filter((e) => e.type === "workflow_node").map((e) => e.payload.node);
  assert.deepEqual(workflowNodes, item.fixture.workflow);
  assert.ok(types.includes("pdf_export"));
  assert.ok(types.includes("tool_execution_start"));
  assert.equal(run.events.find((e) => e.type === "tool_execution_start").payload.toolName, "generate_report");
  assert.deepEqual(run.evidence.workflow, item.fixture.workflow);
  assert.deepEqual(run.evidence.sections, item.fixture.sections);
  assert.equal(run.evidence.exportStatus, item.fixture.exportStatus);
});

test("budget cap: looping tool calls stop at maxTurns with ok=false (双层预算)", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const item = dataset.cases.find((c) => c.mode === "rag");
  const budget = LOOP_EVAL_BUDGETS.rag;
  const run = await runEvalCaseWithLoop(item, { streamFnFactory: () => createLoopingStreamFn() });

  const turnStarts = run.events.filter((e) => e.type === "turn_start").length;
  // config 层 shouldStopAfterTurn 在 maxTurns 截停；runner 硬上限（maxTurns+slack）不应触达。
  assert.equal(turnStarts, budget.maxTurns);
  assert.equal(run.budgetExceeded, true);
  assert.equal(run.evidence.ok, false);
});

test("runLoopEval passes regression gate against existing baseline", async () => {
  const dataset = await loadEvalDataset(datasetPath);
  const report = await runLoopEval(dataset);
  // 无 baseline 时只走绝对阈值门禁；七项指标应全部达标（与改造前口径一致）。
  assert.deepEqual(report.regressionReasons, []);
  assert.equal(report.results.length, dataset.cases.length);
  assert.equal(report.failures.length, report.results.filter((r) => !r.passed).length);
});
