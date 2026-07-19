import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { z } from "zod";
import { createWorkflowPackageSummary, runSequentialWorkflow } from "../dist/index.js";

test("workflow package exposes its boundary summary", () => {
  assert.deepEqual(createWorkflowPackageSummary(), {
    packageName: "@aiagent/workflow",
    boundary: "sequential_node_runtime_state_trace",
    runtimeState: "ready"
  });
});

test("sequential workflow executes nodes, updates state and writes trace", async () => {
  const trace = createInMemoryTraceRecorder("trace_workflow_happy");
  const result = await runSequentialWorkflow({
    workflowName: "test_workflow",
    initialState: { value: 1 },
    trace,
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
  const workflowEvents = trace.getEvents().filter((event) => event.type === "workflow_node");
  assert.equal(workflowEvents.length, 4);
  assert.equal(workflowEvents[0].status, "running");
  assert.equal(workflowEvents[0].inputSummary.value, 1);
  assert.equal(workflowEvents[1].status, "succeeded");
  assert.equal(workflowEvents[1].outputSummary.value, 2);
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
  const trace = createInMemoryTraceRecorder("trace_workflow_loop");
  const result = await runSequentialWorkflow({
    workflowName: "test_loop",
    initialState: { value: 0 },
    maxSteps: 6,
    trace,
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
  assert.deepEqual(
    result.run.nodes.map((node) => node.status),
    ["succeeded", "succeeded"]
  );
  const workflowEvents = trace.getEvents().filter((event) => event.type === "workflow_node");
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

test("workflow pauses before approval node and continues after approval", async () => {
  const trace = createInMemoryTraceRecorder("trace_workflow_approval");
  const approvalRequest = {
    approvalId: "approval_workflow_export",
    traceId: "trace_workflow_approval",
    toolName: "test_exporter",
    reason: "Export requires review.",
    inputPreview: {
      title: "demo"
    },
    permissionLevel: "needs_approval"
  };
  const nodes = [
    {
      nodeId: "export",
      type: "test.export",
      title: "Export",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      buildInput: (state) => ({ value: state.value }),
      createApprovalRequest: () => approvalRequest,
      execute: (input) => ({ value: input.value + 10 }),
      applyOutput: (state, output) => ({ ...state, value: output.value })
    }
  ];
  const paused = await runSequentialWorkflow({
    workflowName: "test_approval_pause",
    runId: "wf_approval",
    initialState: { value: 1 },
    trace,
    nodes
  });

  assert.equal(paused.ok, false);
  assert.equal(paused.run.status, "paused");
  assert.equal(paused.error.code, "approval_required");
  assert.equal(paused.approvalRequest.approvalId, "approval_workflow_export");
  assert.equal(paused.run.nodes[0].status, "paused");

  const approved = await runSequentialWorkflow({
    workflowName: "test_approval_continue",
    runId: "wf_approval",
    initialState: { value: 1 },
    trace,
    nodes,
    approvalDecisions: [
      {
        approvalId: "approval_workflow_export",
        decision: "approved",
        reviewerNote: "ok"
      }
    ]
  });

  assert.equal(approved.ok, true);
  assert.equal(approved.run.status, "succeeded");
  assert.equal(approved.state.value, 11);
  assert.equal(trace.getEvents().some((event) => event.type === "approval" && event.status === "approved"), true);
});

test("workflow rejects approval node without executing it", async () => {
  let executed = false;
  const result = await runSequentialWorkflow({
    workflowName: "test_approval_reject",
    runId: "wf_reject",
    initialState: { value: 1 },
    nodes: [
      {
        nodeId: "export",
        type: "test.export",
        title: "Export",
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        buildInput: (state) => ({ value: state.value }),
        createApprovalRequest: () => ({
          approvalId: "approval_reject_export",
          traceId: "trace_reject",
          toolName: "test_exporter",
          reason: "Export requires review.",
          inputPreview: { title: "demo" },
          permissionLevel: "needs_approval"
        }),
        execute: (input) => {
          executed = true;
          return { value: input.value + 10 };
        },
        applyOutput: (state, output) => ({ ...state, value: output.value })
      }
    ],
    approvalDecisions: [
      {
        approvalId: "approval_reject_export",
        decision: "rejected",
        reviewerNote: "not allowed"
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.run.status, "rejected");
  assert.equal(result.error.code, "approval_rejected");
  assert.equal(executed, false);
});

test("node exceptions and schema failures are returned as workflow errors", async () => {
  const trace = createInMemoryTraceRecorder("trace_workflow_failure");
  const thrown = await runSequentialWorkflow({
    workflowName: "test_throw",
    initialState: {},
    trace,
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
  const failedTraceEvent = trace.getEvents().find((event) => event.type === "workflow_node" && event.status === "failed");
  assert.equal(failedTraceEvent.error.code, "node_execution_failed");
  assert.equal(failedTraceEvent.nodeId, "thrower");

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
