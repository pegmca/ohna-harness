import type {
  WorkflowEdgeDto,
  WorkflowErrorDto,
  WorkflowEventDto,
  WorkflowNodeDto,
  WorkflowRunDto
} from "@aiagent/types";
import type { z } from "zod";

export type WorkflowState = Record<string, unknown>;

/**
 * 节点事件出口（pi 化阶段 5）：approval/TraceRecorder 体系删除后，workflow 观测事件
 * 统一经 sink 流向调用方（report 工具转接到 run_events），payload 形状保持原 trace 事件本体。
 */
export interface WorkflowNodeEvent {
  /** 事件名：runtime 发 "workflow_node"；节点内可发自有事件（如 "pdf_export"、"citation_verifier"）。 */
  type: string;
  /** 事件载荷：与原 trace 事件本体同形状（不含 traceId/requestId，归属由调用方信封提供）。 */
  payload: Record<string, unknown>;
}

/**
 * workflow 事件 sink；实现可以是同步或异步，runtime 一律 await 并吞掉异常（旁路观测不影响主流程）。
 */
export type WorkflowEventSink = (event: WorkflowNodeEvent) => void | Promise<void>;

export interface WorkflowNodeExecutionContext<TState extends WorkflowState> {
  runId: string;
  nodeId: string;
  nodeType: string;
  state: TState;
  /** 节点自有事件出口（如 pdf-exporter 的 pdf_export 占位事件）。 */
  sink?: WorkflowEventSink;
  executedSteps: number;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

export interface WorkflowNodeRecoveryPolicy {
  critical?: boolean;
  onFailure?: "stop" | "skip" | "partial";
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

export interface WorkflowNodeDefinition<TInput, TOutput, TState extends WorkflowState = WorkflowState> {
  nodeId: string;
  type: string;
  title: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  recovery?: WorkflowNodeRecoveryPolicy;
  /**
   * 从当前 workflow state 构造节点输入，所有输入都会继续经过 inputSchema 校验。
   *
   * @param state 当前 workflow state。
   * @returns 未信任的节点输入。
   */
  buildInput(state: TState): unknown;
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
  /** 节点观测事件出口；runtime 的 workflow_node 事件与节点自有事件都经此发出。 */
  sink?: WorkflowEventSink;
  deadlineMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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
    };

export interface WorkflowPackageSummary {
  packageName: "@aiagent/workflow";
  boundary: "sequential_node_runtime_state_trace";
  runtimeState: "ready";
}
