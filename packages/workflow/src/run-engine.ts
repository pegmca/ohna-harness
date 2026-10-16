import type {
  WorkflowErrorDto,
  WorkflowEventDto,
  WorkflowNodeDto,
  WorkflowRunDto
} from "@aiagent/types";
import type {
  RunSequentialWorkflowInput,
  WorkflowPackageSummary,
  WorkflowRunResult,
  WorkflowState
} from "./types.js";
import {
  createSequentialEdges,
  failPendingNode,
  failRunningNode,
  toPendingNodeDto
} from "./node-state.js";
import {
  createWorkflowEvent,
  emitWorkflowNodeEvent,
  summarizeInput,
  summarizeOutput
} from "./events.js";
import {
  buildRunDto,
  createWorkflowRunId,
  defaultWorkflowSleep,
  elapsedMs,
  ensureStepBudget,
  executeWorkflowNode,
  getWorkflowAttempts,
  getWorkflowTerminationError,
  isRuntimeCode,
  normalizeMaxSteps
} from "./runtime-helpers.js";

/**
 * 创建 workflow package 摘要，便于 smoke test 和 README 说明边界。
 *
 * @returns workflow package 当前能力摘要。
 */
export function createWorkflowPackageSummary(): WorkflowPackageSummary {
  return {
    packageName: "@aiagent/workflow",
    boundary: "sequential_node_runtime_state_trace",
    runtimeState: "ready"
  };
}

export async function runSequentialWorkflow<TState extends WorkflowState>(
  input: RunSequentialWorkflowInput<TState>
): Promise<WorkflowRunResult<TState>> {
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  const runId = input.runId ?? createWorkflowRunId(input.workflowName);
  const maxSteps = normalizeMaxSteps(input.maxSteps);
  const nodes = input.nodes.map(toPendingNodeDto);
  const events: WorkflowEventDto[] = [];
  const edges = createSequentialEdges(input.nodes);
  let state = { ...input.initialState } as TState;
  let executedSteps = 0;
  const now = input.now ?? Date.now;
  const deadlineAtMs = input.deadlineAtMs ?? (input.deadlineMs === undefined ? undefined : now() + input.deadlineMs);
  const recovery: NonNullable<WorkflowRunDto["recovery"]> = [];

  if (input.nodes.length === 0) {
    const error: WorkflowErrorDto = {
      code: "invalid_workflow",
      message: "Workflow must include at least one node."
    };
    events.push(createWorkflowEvent("workflow_failed", undefined, { nodeCount: 0 }, error));
    return {
      ok: false,
      state,
      error,
      run: buildRunDto({
        runId,
        workflowName: input.workflowName,
        status: "failed",
        startedAt,
        startedAtMs,
        maxSteps,
        executedSteps,
        nodes,
        edges,
        events,
        error
      })
    };
  }

  let nodeIndex = 0;

  while (nodeIndex >= 0 && nodeIndex < input.nodes.length) {
    const definition = input.nodes[nodeIndex];
    const terminationError = getWorkflowTerminationError(input.signal, deadlineAtMs, now, definition.nodeId);
    if (terminationError) {
      nodes[nodeIndex] = failPendingNode(nodes[nodeIndex], terminationError);
      events.push(createWorkflowEvent("workflow_failed", definition.nodeId, { terminationReason: terminationError.code }, terminationError));
      await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", terminationError);
      return { ok: false, state, error: terminationError, run: buildRunDto({ runId, workflowName: input.workflowName, status: "failed", startedAt, startedAtMs, maxSteps, executedSteps, nodes, edges, events, error: terminationError, recovery }) };
    }
    const budgetError = ensureStepBudget(executedSteps, maxSteps, definition.nodeId);

    if (budgetError) {
      nodes[nodeIndex] = failPendingNode(nodes[nodeIndex], budgetError);
      events.push(createWorkflowEvent("workflow_failed", definition.nodeId, { maxSteps, executedSteps }, budgetError));
      await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", budgetError);
      return {
        ok: false,
        state,
        error: budgetError,
        run: buildRunDto({
          runId,
          workflowName: input.workflowName,
          status: "failed",
          startedAt,
          startedAtMs,
          maxSteps,
          executedSteps,
          nodes,
          edges,
          events,
          error: budgetError
        })
      };
    }

    const nodeStartedAtMs = performance.now();
    const nodeStartedAt = new Date().toISOString();

    const rawInput = definition.buildInput(state);
    const parsedInput = definition.inputSchema.safeParse(rawInput);

    executedSteps += 1;

    if (!parsedInput.success) {
      const error: WorkflowErrorDto = {
        code: "invalid_node_input",
        message: `Invalid input for workflow node: ${definition.nodeId}`,
        nodeId: definition.nodeId,
        details: {
          issues: parsedInput.error.issues
        }
      };
      nodes[nodeIndex] = failRunningNode(nodes[nodeIndex], nodeStartedAt, nodeStartedAtMs, error);
      events.push(createWorkflowEvent("node_started", definition.nodeId, { nodeType: definition.type }));
      events.push(createWorkflowEvent("node_failed", definition.nodeId, undefined, error));
      await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", error);
      return {
        ok: false,
        state,
        error,
        run: buildRunDto({
          runId,
          workflowName: input.workflowName,
          status: "failed",
          startedAt,
          startedAtMs,
          maxSteps,
          executedSteps,
          nodes,
          edges,
          events,
          error
        })
      };
    }

    const inputSummary = summarizeInput(definition, parsedInput.data);
    nodes[nodeIndex] = {
      ...nodes[nodeIndex],
      status: "running",
      startedAt: nodeStartedAt,
      inputSummary
    };
    try {
      const policy = definition.recovery ?? {};
      const maxAttempts = Math.max(1, policy.maxAttempts ?? 1);
      let rawOutput: unknown;
      let attempt = 0;
      while (attempt < maxAttempts) {
        attempt += 1;
        events.push(createWorkflowEvent("node_started", definition.nodeId, {
          nodeType: definition.type,
          inputSummary,
          attempt
        }));
        await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "running");
        try {
          rawOutput = await executeWorkflowNode(definition, parsedInput.data, {
        runId,
        nodeId: definition.nodeId,
        nodeType: definition.type,
        state,
        sink: input.sink,
        executedSteps, signal: input.signal, deadlineAtMs
      }, policy.timeoutMs, deadlineAtMs, now);
          break;
        } catch (error) {
          if (attempt >= maxAttempts || !policy.isRetryable?.(error)) throw Object.assign(error instanceof Error ? error : new Error("Workflow node failed."), { workflowAttempts: attempt });
          const retryError: WorkflowErrorDto = {
            code: "node_execution_failed",
            message: error instanceof Error ? error.message : "Retryable workflow node attempt failed.",
            nodeId: definition.nodeId,
            details: { attempt, retryable: true }
          };
          events.push(createWorkflowEvent("node_failed", definition.nodeId, {
            attempt,
            retryable: true
          }, retryError));
          recovery.push({ nodeId: definition.nodeId, action: "retried", attempts: attempt, reason: error instanceof Error ? error.message : "retryable_error" });
          await (input.sleep ?? defaultWorkflowSleep)((policy.baseDelayMs ?? 100) * 2 ** (attempt - 1), input.signal);
        }
      }
      const parsedOutput = definition.outputSchema.safeParse(rawOutput);

      if (!parsedOutput.success) {
        const error: WorkflowErrorDto = {
          code: "invalid_node_output",
          message: `Invalid output from workflow node: ${definition.nodeId}`,
          nodeId: definition.nodeId,
          details: {
            issues: parsedOutput.error.issues
          }
        };
        nodes[nodeIndex] = failRunningNode(nodes[nodeIndex], nodeStartedAt, nodeStartedAtMs, error);
        events.push(createWorkflowEvent("node_failed", definition.nodeId, undefined, error));
        await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", error);
        return {
          ok: false,
          state,
          error,
          run: buildRunDto({
            runId,
            workflowName: input.workflowName,
            status: "failed",
            startedAt,
            startedAtMs,
            maxSteps,
            executedSteps,
            nodes,
            edges,
            events,
            error
          })
        };
      }

      const outputSummary = summarizeOutput(definition, parsedOutput.data);
      state = definition.applyOutput(state, parsedOutput.data);
      nodes[nodeIndex] = {
        ...nodes[nodeIndex],
        status: "succeeded",
        completedAt: new Date().toISOString(),
        durationMs: elapsedMs(nodeStartedAtMs),
        outputSummary
      };
      events.push(createWorkflowEvent("node_succeeded", definition.nodeId, { outputSummary }));
      await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "succeeded");

      const nextNodeId = definition.decideNext?.(parsedOutput.data, {
        runId,
        nodeId: definition.nodeId,
        nodeType: definition.type,
        state,
        sink: input.sink,
        executedSteps
      });

      if (nextNodeId) {
        const nextIndex = input.nodes.findIndex((node) => node.nodeId === nextNodeId);

        if (nextIndex >= 0) {
          nodeIndex = nextIndex;
          continue;
        }
      }

      nodeIndex += 1;
    } catch (caught) {
      const policy = definition.recovery ?? {};
      const recoveryAction = policy.critical === false ? (policy.onFailure ?? "partial") : "stop";
      const error: WorkflowErrorDto = {
        code: isRuntimeCode(caught, "node_timeout") ? "node_timeout" : isRuntimeCode(caught, "workflow_cancelled") ? "workflow_cancelled" : isRuntimeCode(caught, "workflow_deadline_exceeded") ? "workflow_deadline_exceeded" : "node_execution_failed",
        message: caught instanceof Error ? caught.message : `Workflow node failed: ${definition.nodeId}`,
        nodeId: definition.nodeId,
        details: { attempts: getWorkflowAttempts(caught), recoveryAction }
      };
      if (recoveryAction === "skip" || recoveryAction === "partial") {
        nodes[nodeIndex] = { ...failRunningNode(nodes[nodeIndex], nodeStartedAt, nodeStartedAtMs, error), status: "skipped" };
        recovery.push({ nodeId: definition.nodeId, action: recoveryAction === "skip" ? "skipped" : "partial", attempts: getWorkflowAttempts(caught), reason: error.message });
        events.push(createWorkflowEvent("node_failed", definition.nodeId, { recoveryAction }, error));
        await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", error);
        nodeIndex += 1;
        continue;
      }
      nodes[nodeIndex] = failRunningNode(nodes[nodeIndex], nodeStartedAt, nodeStartedAtMs, error);
      events.push(createWorkflowEvent("node_failed", definition.nodeId, undefined, error));
      await emitWorkflowNodeEvent(input.sink, runId, definition, nodes[nodeIndex], "failed", error);
      return {
        ok: false,
        state,
        error,
        run: buildRunDto({
          runId,
          workflowName: input.workflowName,
          status: "failed",
          startedAt,
          startedAtMs,
          maxSteps,
          executedSteps,
          nodes,
          edges,
          events,
          error
        })
      };
    }
  }

  events.push(createWorkflowEvent("workflow_succeeded", undefined, { executedSteps }));

  return {
    ok: true,
    state,
    run: buildRunDto({
      runId,
      workflowName: input.workflowName,
      status: "succeeded",
      startedAt,
      startedAtMs,
      maxSteps,
      executedSteps,
      nodes,
      edges,
      events,
      partial: recovery.some((item) => item.action === "partial" || item.action === "skipped"), recovery
    })
  };
}
