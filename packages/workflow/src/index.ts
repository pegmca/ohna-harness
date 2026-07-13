import type { TraceRecorder } from "@aiagent/trace";
import type {
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto,
  WorkflowEdgeDto,
  WorkflowErrorDto,
  WorkflowEventDto,
  WorkflowNodeDto,
  WorkflowRunDto
} from "@aiagent/types";
import type { z } from "zod";

export type WorkflowState = Record<string, unknown>;

export interface WorkflowNodeExecutionContext<TState extends WorkflowState> {
  runId: string;
  nodeId: string;
  nodeType: string;
  state: TState;
  trace?: TraceRecorder;
  executedSteps: number;
}

export interface WorkflowNodeDefinition<TInput, TOutput, TState extends WorkflowState = WorkflowState> {
  nodeId: string;
  type: string;
  title: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /**
   * 从当前 workflow state 构造节点输入，所有输入都会继续经过 inputSchema 校验。
   *
   * @param state 当前 workflow state。
   * @returns 未信任的节点输入。
   */
  buildInput(state: TState): unknown;
  /**
   * 在节点执行前生成审批请求；runtime 会先检查 approval decision，未批准则暂停或拒绝。
   *
   * @param state 当前 workflow state。
   * @param context 当前节点执行上下文。
   * @returns 审批请求；没有敏感动作时返回 undefined。
   */
  createApprovalRequest?(
    state: TState,
    context: WorkflowNodeExecutionContext<TState>
  ): ToolApprovalRequestDto | undefined;
  /**
   * 执行节点逻辑。节点可以抛错，runtime 会统一转成结构化 WorkflowError。
   *
   * @param input 通过 inputSchema 校验后的节点输入。
   * @param context 当前节点执行上下文。
   * @returns 未信任的节点输出，runtime 会继续使用 outputSchema 校验。
   */
  execute(input: TInput, context: WorkflowNodeExecutionContext<TState>): TOutput | Promise<TOutput>;
  /**
   * 将已校验的节点输出写回 state，保持 runtime 不理解业务字段。
   *
   * @param state 当前 workflow state。
   * @param output 通过 outputSchema 校验后的节点输出。
   * @returns 新的 workflow state。
   */
  applyOutput(state: TState, output: TOutput): TState;
  /**
   * 节点执行成功后，决定下一个要执行的节点。返回 nodeId 时跳转到对应节点，
   * 用来实现 verifier loop 等有限循环；返回 undefined 时按顺序执行下一个节点。
   *
   * @param output 已校验的节点输出。
   * @param context 当前节点执行上下文。
   * @returns 下一个节点的 nodeId，或 undefined。
   */
  decideNext?(output: TOutput, context: WorkflowNodeExecutionContext<TState>): string | undefined;
  summarizeInput?: (input: TInput) => Record<string, unknown>;
  summarizeOutput?: (output: TOutput) => Record<string, unknown>;
}

export type AnyWorkflowNodeDefinition<TState extends WorkflowState = WorkflowState> = WorkflowNodeDefinition<any, any, TState>;

export interface RunSequentialWorkflowInput<TState extends WorkflowState> {
  workflowName: string;
  runId?: string;
  initialState: TState;
  nodes: readonly AnyWorkflowNodeDefinition<TState>[];
  maxSteps?: number;
  trace?: TraceRecorder;
  approvalDecisions?: ToolApprovalDecisionDto[];
}

export type WorkflowRunResult<TState extends WorkflowState = WorkflowState> =
  | {
      ok: true;
      run: WorkflowRunDto;
      state: TState;
    }
  | {
      ok: false;
      run: WorkflowRunDto;
      state: TState;
      error: WorkflowErrorDto;
      approvalRequest?: ToolApprovalRequestDto;
    };

export interface WorkflowPackageSummary {
  packageName: "@aiagent/workflow";
  boundary: "sequential_node_runtime_state_trace";
  runtimeState: "ready";
}

const DEFAULT_MAX_STEPS = 12;

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

/**
 * 执行第一版顺序 workflow runtime，提供 schema 校验、max steps、状态流转和 trace 写入。
 *
 * @template TState workflow state 类型。
 * @param input workflow 定义、初始 state 和执行选项。
 * @returns 结构化 workflow 结果；节点异常不会向调用方泄漏。
 */
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
    const budgetError = ensureStepBudget(executedSteps, maxSteps, definition.nodeId);

    if (budgetError) {
      nodes[nodeIndex] = failPendingNode(nodes[nodeIndex], budgetError);
      events.push(createWorkflowEvent("workflow_failed", definition.nodeId, { maxSteps, executedSteps }, budgetError));
      recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "failed", budgetError);
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
    const approvalRequest = definition.createApprovalRequest?.(state, {
      runId,
      nodeId: definition.nodeId,
      nodeType: definition.type,
      state,
      trace: input.trace,
      executedSteps
    });

    if (approvalRequest) {
      const approvalDecision = input.approvalDecisions?.find((decision) => decision.approvalId === approvalRequest.approvalId);

      if (approvalDecision?.decision === "rejected") {
        const error: WorkflowErrorDto = {
          code: "approval_rejected",
          message: `Workflow node rejected by reviewer: ${definition.nodeId}`,
          nodeId: definition.nodeId,
          details: {
            approvalId: approvalRequest.approvalId,
            reviewerNote: approvalDecision.reviewerNote
          }
        };
        nodes[nodeIndex] = markNodeWithApproval(nodes[nodeIndex], "rejected", nodeStartedAt, nodeStartedAtMs, approvalRequest, error);
        events.push(createWorkflowEvent("node_rejected", definition.nodeId, { approvalRequest }, error));
        events.push(createWorkflowEvent("workflow_rejected", definition.nodeId, { approvalRequest }, error));
        recordApprovalTrace(input.trace, approvalRequest, "rejected", approvalDecision.reviewerNote);
        recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "rejected", error);
        return {
          ok: false,
          state,
          error,
          approvalRequest,
          run: buildRunDto({
            runId,
            workflowName: input.workflowName,
            status: "rejected",
            startedAt,
            startedAtMs,
            maxSteps,
            executedSteps,
            nodes,
            edges,
            events,
            approvalRequest,
            error
          })
        };
      }

      if (approvalDecision?.decision !== "approved") {
        const error: WorkflowErrorDto = {
          code: "approval_required",
          message: `Workflow paused before sensitive node: ${definition.nodeId}`,
          nodeId: definition.nodeId,
          details: {
            approvalId: approvalRequest.approvalId,
            permissionLevel: approvalRequest.permissionLevel
          }
        };
        nodes[nodeIndex] = markNodeWithApproval(nodes[nodeIndex], "paused", nodeStartedAt, nodeStartedAtMs, approvalRequest, error);
        events.push(createWorkflowEvent("node_paused", definition.nodeId, { approvalRequest }, error));
        events.push(createWorkflowEvent("workflow_paused", definition.nodeId, { approvalRequest }, error));
        recordApprovalTrace(input.trace, approvalRequest, "requested");
        recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "paused", error);
        return {
          ok: false,
          state,
          error,
          approvalRequest,
          run: buildRunDto({
            runId,
            workflowName: input.workflowName,
            status: "paused",
            startedAt,
            startedAtMs,
            maxSteps,
            executedSteps,
            nodes,
            edges,
            events,
            approvalRequest,
            error
          })
        };
      }

      events.push(createWorkflowEvent("node_approved", definition.nodeId, { approvalRequest }));
      events.push(createWorkflowEvent("workflow_approved", definition.nodeId, { approvalRequest }));
      recordApprovalTrace(input.trace, approvalRequest, "approved", approvalDecision.reviewerNote);
    }

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
      recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "failed", error);
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
    events.push(createWorkflowEvent("node_started", definition.nodeId, { nodeType: definition.type, inputSummary }));
    recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "running");

    try {
      const rawOutput = await definition.execute(parsedInput.data, {
        runId,
        nodeId: definition.nodeId,
        nodeType: definition.type,
        state,
        trace: input.trace,
        executedSteps
      });
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
        recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "failed", error);
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
      recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "succeeded");

      const nextNodeId = definition.decideNext?.(parsedOutput.data, {
        runId,
        nodeId: definition.nodeId,
        nodeType: definition.type,
        state,
        trace: input.trace,
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
      const error: WorkflowErrorDto = {
        code: "node_execution_failed",
        message: caught instanceof Error ? caught.message : `Workflow node failed: ${definition.nodeId}`,
        nodeId: definition.nodeId
      };
      nodes[nodeIndex] = failRunningNode(nodes[nodeIndex], nodeStartedAt, nodeStartedAtMs, error);
      events.push(createWorkflowEvent("node_failed", definition.nodeId, undefined, error));
      recordWorkflowTrace(input.trace, runId, definition, nodes[nodeIndex], "failed", error);
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
      events
    })
  };
}

/**
 * 将节点定义初始化为 pending DTO，runtime 后续只更新 DTO 状态。
 *
 * @param definition 节点定义。
 * @returns pending node DTO。
 */
function toPendingNodeDto(definition: AnyWorkflowNodeDefinition<WorkflowState>): WorkflowNodeDto {
  return {
    nodeId: definition.nodeId,
    type: definition.type,
    title: definition.title,
    status: "pending",
    durationMs: 0
  };
}

/**
 * 为顺序节点生成线性 edge，第一版不实现复杂 DAG。
 *
 * @param nodes 顺序节点定义。
 * @returns workflow edge DTO 列表。
 */
function createSequentialEdges(nodes: readonly AnyWorkflowNodeDefinition<WorkflowState>[]): WorkflowEdgeDto[] {
  return nodes.slice(0, -1).map((node, index) => ({
    from: node.nodeId,
    to: nodes[index + 1].nodeId
  }));
}

/**
 * 校验 max steps，任何节点执行前都会检查，避免 verifier/retry loop 未来无限执行。
 *
 * @param executedSteps 已执行节点数。
 * @param maxSteps 最大节点数。
 * @param nodeId 当前节点。
 * @returns 超限时的结构化错误。
 */
function ensureStepBudget(executedSteps: number, maxSteps: number, nodeId: string): WorkflowErrorDto | undefined {
  if (executedSteps < maxSteps) {
    return undefined;
  }

  return {
    code: "max_steps_exceeded",
    message: `Workflow 已达到 maxSteps=${maxSteps}，停止在节点 ${nodeId}。`,
    nodeId,
    details: {
      maxSteps,
      executedSteps
    }
  };
}

/**
 * 构造失败节点 DTO，保留 pending 节点被 max steps 截断的事实。
 *
 * @param node 原节点 DTO。
 * @param error 结构化错误。
 * @returns failed node DTO。
 */
function failPendingNode(node: WorkflowNodeDto, error: WorkflowErrorDto): WorkflowNodeDto {
  return {
    ...node,
    status: "failed",
    completedAt: new Date().toISOString(),
    durationMs: 0,
    error
  };
}

/**
 * 构造运行中失败节点 DTO，统一计算耗时和完成时间。
 *
 * @param node 原节点 DTO。
 * @param startedAt 节点开始时间。
 * @param startedAtMs performance 起始时间。
 * @param error 结构化错误。
 * @returns failed node DTO。
 */
function failRunningNode(
  node: WorkflowNodeDto,
  startedAt: string,
  startedAtMs: number,
  error: WorkflowErrorDto
): WorkflowNodeDto {
  return {
    ...node,
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(startedAtMs),
    error
  };
}

/**
 * 构造带审批状态的节点 DTO，暂停/拒绝时保留 approval request 摘要。
 *
 * @param node 原节点 DTO。
 * @param status 审批相关节点状态。
 * @param startedAt 节点开始时间。
 * @param startedAtMs performance 起始时间。
 * @param approvalRequest 审批请求。
 * @param error 结构化审批错误。
 * @returns paused/rejected node DTO。
 */
function markNodeWithApproval(
  node: WorkflowNodeDto,
  status: "paused" | "rejected",
  startedAt: string,
  startedAtMs: number,
  approvalRequest: ToolApprovalRequestDto,
  error: WorkflowErrorDto
): WorkflowNodeDto {
  return {
    ...node,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(startedAtMs),
    inputSummary: {
      approvalId: approvalRequest.approvalId,
      toolName: approvalRequest.toolName,
      permissionLevel: approvalRequest.permissionLevel,
      inputPreview: approvalRequest.inputPreview
    },
    error
  };
}

/**
 * 写入 workflow 级 approval trace event；审批事件只包含 preview，不记录完整敏感 payload。
 *
 * @param trace trace recorder。
 * @param request 审批请求。
 * @param status 审批状态。
 * @param reviewerNote reviewer 说明。
 */
function recordApprovalTrace(
  trace: TraceRecorder | undefined,
  request: ToolApprovalRequestDto,
  status: "requested" | "approved" | "rejected",
  reviewerNote?: string
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "approval",
      id: `${trace.traceId}_${request.approvalId}_${status}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      approvalId: request.approvalId,
      toolName: request.toolName,
      status,
      reason: request.reason,
      inputPreview: request.inputPreview,
      reviewerNote,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，不能影响 workflow 权限边界。
  }
}

/**
 * 写入 workflow node trace event，trace 失败不影响 workflow 主流程。
 *
 * @param trace trace recorder。
 * @param runId workflow run id。
 * @param definition 节点定义。
 * @param node 当前节点 DTO。
 * @param status trace 状态。
 * @param error 可选错误。
 */
function recordWorkflowTrace(
  trace: TraceRecorder | undefined,
  runId: string,
  definition: AnyWorkflowNodeDefinition<WorkflowState>,
  node: WorkflowNodeDto,
  status: WorkflowNodeDto["status"],
  error?: WorkflowErrorDto
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "workflow_node",
      id: `${trace.traceId}_${runId}_${definition.nodeId}_${status}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      workflowRunId: runId,
      nodeId: definition.nodeId,
      nodeType: definition.type,
      status,
      durationMs: node.durationMs,
      inputSummary: node.inputSummary,
      outputSummary: node.outputSummary,
      error,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，不能影响 workflow 执行结果。
  }
}

/**
 * 生成 workflow event DTO。
 *
 * @param type 事件类型。
 * @param nodeId 可选节点 id。
 * @param data 可选事件数据。
 * @param error 可选结构化错误。
 * @returns workflow event DTO。
 */
function createWorkflowEvent(
  type: WorkflowEventDto["type"],
  nodeId?: string,
  data?: Record<string, unknown>,
  error?: WorkflowErrorDto
): WorkflowEventDto {
  return {
    id: `workflow_event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    nodeId,
    data,
    error,
    createdAt: new Date().toISOString()
  };
}

/**
 * 汇总节点输入，优先使用节点自定义摘要，避免 trace 记录完整敏感 payload。
 *
 * @param definition 节点定义。
 * @param input 已校验输入。
 * @returns 输入摘要。
 */
function summarizeInput<TInput>(
  definition: WorkflowNodeDefinition<TInput, any, WorkflowState>,
  input: TInput
): Record<string, unknown> {
  return definition.summarizeInput?.(input) ?? summarizeValue(input);
}

/**
 * 汇总节点输出，优先使用节点自定义摘要，避免 trace 记录完整报告正文。
 *
 * @param definition 节点定义。
 * @param output 已校验输出。
 * @returns 输出摘要。
 */
function summarizeOutput<TOutput>(
  definition: WorkflowNodeDefinition<any, TOutput, WorkflowState>,
  output: TOutput
): Record<string, unknown> {
  return definition.summarizeOutput?.(output) ?? summarizeValue(output);
}

/**
 * 对未知值生成低风险摘要；长文本只记录长度和预览。
 *
 * @param value 未知值。
 * @returns trace 安全摘要。
 */
function summarizeValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {
      value
    };
  }

  if (Array.isArray(value)) {
    return {
      itemCount: value.length
    };
  }

  const summary: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      summary[key] = child.length > 80 ? `${child.slice(0, 77)}...` : child;
    } else if (Array.isArray(child)) {
      summary[key] = {
        itemCount: child.length
      };
    } else if (child && typeof child === "object") {
      summary[key] = {
        keys: Object.keys(child).slice(0, 8)
      };
    } else {
      summary[key] = child;
    }
  }

  return summary;
}

/**
 * 构建 workflow run DTO。
 *
 * @param input run 字段。
 * @returns workflow run DTO。
 */
function buildRunDto(input: {
  runId: string;
  workflowName: string;
  status: WorkflowRunDto["status"];
  startedAt: string;
  startedAtMs: number;
  maxSteps: number;
  executedSteps: number;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  events: WorkflowEventDto[];
  approvalRequest?: ToolApprovalRequestDto;
  error?: WorkflowErrorDto;
}): WorkflowRunDto {
  return {
    runId: input.runId,
    workflowName: input.workflowName,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: elapsedMs(input.startedAtMs),
    maxSteps: input.maxSteps,
    executedSteps: input.executedSteps,
    nodes: input.nodes,
    edges: input.edges,
    events: input.events,
    approvalRequest: input.approvalRequest,
    error: input.error
  };
}

/**
 * 标准化 max steps，非法输入按 0 处理以触发结构化失败。
 *
 * @param maxSteps 调用方传入值。
 * @returns 可比较的整数。
 */
function normalizeMaxSteps(maxSteps: number | undefined): number {
  if (maxSteps === undefined) {
    return DEFAULT_MAX_STEPS;
  }

  if (!Number.isFinite(maxSteps)) {
    return 0;
  }

  return Math.max(0, Math.floor(maxSteps));
}

/**
 * 生成 workflow run id，避免为学习阶段引入 UUID 依赖。
 *
 * @param workflowName workflow 名称。
 * @returns run id。
 */
function createWorkflowRunId(workflowName: string): string {
  const normalized = workflowName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `wf_${normalized || "run"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 计算耗时并保留两位小数。
 *
 * @param startedAt performance.now 起始值。
 * @returns 毫秒耗时。
 */
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
