import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createWorkflowPackageSummary, runSequentialWorkflow } from "../dist/index.js";

test("workflow package exposes its boundary summary", () => {
  assert.deepEqual(createWorkflowPackageSummary(), {
    packageName: "@aiagent/workflow",
    boundary: "sequential_node_runtime_state_trace",
    runtimeState: "ready"
  });
});

test("sequential workflow executes nodes, updates state and emits node events via sink", async () => {
  const events = [];
  const result = await runSequentialWorkflow({
    workflowName: "test_workflow",
    initialState: { value: 1 },
    sink: (event) => { events.push(event); },
    nodes: [
      {
        nodeId: "increment",
        type: "test.increment",
        title: "Increment",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value + 1 }),
        applyOutput: (state, output) => ({ ...state, value: output.value })
      },
      {
        nodeId: "double",
        type: "test.double",
        title: "Double",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value * 2 }),
        applyOutput: (state, output) => ({ ...state, value: output.value })
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.value, 4);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.executedSteps, 2);
  assert.deepEqual(
    result.run.nodes.map((node) => node.status),
    ["succeeded", "succeeded"]
  );
  const workflowEvents = events.filter((event) => event.type === "workflow_node");
  assert.equal(workflowEvents.length, 4);
  assert.equal(workflowEvents[0].payload.status, "running");
  assert.equal(workflowEvents[0].payload.inputSummary.value, 1);
  assert.equal(workflowEvents[1].payload.status, "succeeded");
  assert.equal(workflowEvents[1].payload.outputSummary.value, 2);
});

test("max steps returns structured failure before executing the next node", async () => {
  const result = await runSequentialWorkflow({
    workflowName: "test_max_steps",
    initialState: { value: 1 },
    maxSteps: 1,
    nodes: [
      {
        nodeId: "first",
        type: "test.first",
        title: "First",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value + 1 }),
        applyOutput: (state, output) => ({ ...state, value: output.value })
      },
      {
        nodeId: "second",
        type: "test.second",
        title: "Second",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value + 1 }),
        applyOutput: (state, output) => ({ ...state, value: output.value })
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "max_steps_exceeded");
  assert.equal(result.error.nodeId, "second");
  assert.equal(result.run.executedSteps, 1);
  assert.equal(result.run.nodes[1].status, "failed");
});

test("workflow retries a transient node and records recovery without real waiting", async () => {
  let calls = 0;
  const result = await runSequentialWorkflow({ workflowName: "retry", initialState: { value: 0 }, sleep: async () => undefined, nodes: [{ nodeId: "flaky", type: "test", title: "Flaky", inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }), buildInput: () => ({}), recovery: { maxAttempts: 2, isRetryable: () => true }, execute: () => { calls += 1; if (calls === 1) throw new Error("temporary"); return { value: 1 }; }, applyOutput: (state, output) => ({ ...state, value: output.value }) }] });
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(result.run.recovery[0].action, "retried");
  assert.deepEqual(
    result.run.events.filter((event) => event.nodeId === "flaky").map((event) => [event.type, event.data?.attempt, event.error?.message]),
    [
      ["node_started", 1, undefined],
      ["node_failed", 1, "temporary"],
      ["node_started", 2, undefined],
      ["node_succeeded", undefined, undefined]
    ]
  );
});

test("workflow deadline terminates with structured partial state", async () => {
  const result = await runSequentialWorkflow({ workflowName: "deadline", initialState: { value: 4 }, deadlineAtMs: 10, now: () => 10, nodes: [{ nodeId: "never", type: "test", title: "Never", inputSchema: z.object({}), outputSchema: z.object({}), buildInput: () => ({}), execute: () => ({}), applyOutput: (state) => state }] });
  assert.equal(result.ok, false); assert.equal(result.error.code, "workflow_deadline_exceeded"); assert.equal(result.state.value, 4);
});

test("non-critical node can be skipped and workflow returns partial success", async () => {
  const result = await runSequentialWorkflow({ workflowName: "partial", initialState: { value: 1 }, nodes: [{ nodeId: "optional", type: "test", title: "Optional", inputSchema: z.object({}), outputSchema: z.object({}), buildInput: () => ({}), recovery: { critical: false, onFailure: "partial" }, execute: () => { throw new Error("source unavailable"); }, applyOutput: (state) => state }, { nodeId: "finish", type: "test", title: "Finish", inputSchema: z.object({}), outputSchema: z.object({}), buildInput: () => ({}), execute: () => ({}), applyOutput: (state) => ({ ...state, done: true }) }] });
  assert.equal(result.ok, true); assert.equal(result.run.partial, true); assert.equal(result.state.done, true); assert.equal(result.run.nodes[0].status, "skipped");
});

test("decideNext can loop back to an earlier node with max steps protection", async () => {
  const events = [];
  const result = await runSequentialWorkflow({
    workflowName: "test_loop",
    initialState: { value: 0 },
    maxSteps: 6,
    sink: (event) => { events.push(event); },
    nodes: [
      {
        nodeId: "increment",
        type: "test.increment",
        title: "Increment",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value + 1 }),
        applyOutput: (state, output) => ({ ...state, value: output.value }),
        decideNext: (output) => (output.value < 3 ? "increment" : undefined)
      },
      {
        nodeId: "finalize",
        type: "test.finalize",
        title: "Finalize",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value * 10 }),
        applyOutput: (state, output) => ({ ...state, value: output.value })
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.value, 30);
  assert.equal(result.run.executedSteps, 4);
  assert.equal(result.run.events.filter((event) => event.nodeId === "increment" && event.type === "node_failed").length, 0);
  assert.equal(result.run.events.filter((event) => event.nodeId === "increment" && event.type === "node_succeeded").length, 3);
  assert.deepEqual(
    result.run.nodes.map((node) => node.status),
    ["succeeded", "succeeded"]
  );
  const workflowEvents = events.filter((event) => event.type === "workflow_node");
  assert.equal(workflowEvents.length, 8);

  const maxStepsResult = await runSequentialWorkflow({
    workflowName: "test_loop_max_steps",
    initialState: { value: 0 },
    maxSteps: 2,
    nodes: [
      {
        nodeId: "increment",
        type: "test.increment",
        title: "Increment",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        execute: (input) => ({ value: input.value + 1 }),
        applyOutput: (state, output) => ({ ...state, value: output.value }),
        decideNext: () => "increment"
      }
    ]
  });

  assert.equal(maxStepsResult.ok, false);
  assert.equal(maxStepsResult.error.code, "max_steps_exceeded");
  assert.equal(maxStepsResult.run.executedSteps, 2);
});

test("node exceptions and schema failures are returned as workflow errors", async () => {
  const events = [];
  const thrown = await runSequentialWorkflow({
    workflowName: "test_throw",
    initialState: {},
    sink: (event) => { events.push(event); },
    nodes: [
      {
        nodeId: "thrower",
        type: "test.thrower",
        title: "Thrower",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        buildInput: () => ({}),
        execute: () => {
          throw new Error("boom");
        },
        applyOutput: (state) => state
      }
    ]
  });

  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "node_execution_failed");
  assert.match(thrown.error.message, /boom/);
  const failedTraceEvent = events.find((event) => event.type === "workflow_node" && event.payload.status === "failed");
  assert.equal(failedTraceEvent.payload.error.code, "node_execution_failed");
  assert.equal(failedTraceEvent.payload.nodeId, "thrower");

  const badOutput = await runSequentialWorkflow({
    workflowName: "test_bad_output",
    initialState: {},
    nodes: [
      {
        nodeId: "bad_output",
        type: "test.bad_output",
        title: "Bad Output",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        buildInput: () => ({}),
        execute: () => ({ ok: "yes" }),
        applyOutput: (state) => state
      }
    ]
  });

  assert.equal(badOutput.ok, false);
  assert.equal(badOutput.error.code, "invalid_node_output");
});
