import type {
  WorkflowEdgeDto,
  WorkflowErrorDto,
  WorkflowEventDto,
  WorkflowNodeDto,
  WorkflowRunDto
} from "@aiagent/types";
import type {
  AnyWorkflowNodeDefinition,
  WorkflowNodeExecutionContext,
  WorkflowState
} from "./types.js";

/** 未显式配置 maxSteps 时的默认上限，防止 verifier/retry loop 未来无限执行。 */
const DEFAULT_MAX_STEPS = 12;

/** 在单节点 timeout 与 workflow deadline 的更小预算内执行节点。 */
export async function executeWorkflowNode<TState extends WorkflowState>(definition: AnyWorkflowNodeDefinition<TState>, nodeInput: unknown, context: WorkflowNodeExecutionContext<TState>, timeoutMs: number | undefined, deadlineAtMs: number | undefined, now: () => number): Promise<unknown> {
  const remaining = deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : deadlineAtMs - now();
  const budget = Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, remaining);
  if (budget <= 0) throw Object.assign(new Error("Workflow deadline exceeded."), { code: "workflow_deadline_exceeded" });
  if (context.signal?.aborted) throw Object.assign(new Error("Workflow cancelled."), { code: "workflow_cancelled" });
  if (!Number.isFinite(budget)) return definition.execute(nodeInput, context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineDominates = remaining <= (timeoutMs ?? Number.POSITIVE_INFINITY);
  try { return await Promise.race([definition.execute(nodeInput, context), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(deadlineDominates ? "Workflow deadline exceeded." : `Workflow node timed out after ${budget}ms.`), { code: deadlineDominates ? "workflow_deadline_exceeded" : "node_timeout" })), budget); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** 在节点开始前生成取消或 deadline 的结构化终止错误。 */
export function getWorkflowTerminationError(signal: AbortSignal | undefined, deadlineAtMs: number | undefined, now: () => number, nodeId: string): WorkflowErrorDto | undefined {
  if (signal?.aborted) return { code: "workflow_cancelled", message: "Workflow cancelled.", nodeId };
  if (deadlineAtMs !== undefined && now() >= deadlineAtMs) return { code: "workflow_deadline_exceeded", message: "Workflow deadline exceeded.", nodeId };
  return undefined;
}

/** 判断未知异常是否带指定 runtime code。 */
export function isRuntimeCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** 从重试包装异常中读取尝试次数。 */
export function getWorkflowAttempts(error: unknown): number {
  return error && typeof error === "object" && "workflowAttempts" in error && typeof error.workflowAttempts === "number" ? error.workflowAttempts : 1;
}

/** 默认 workflow sleeper 支持取消，测试可注入即时实现。 */
export function defaultWorkflowSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Workflow cancelled."), { code: "workflow_cancelled" }));
    }, { once: true });
  });
}

/**
 * 校验 max steps，任何节点执行前都会检查，避免 verifier/retry loop 未来无限执行。
 *
 * @param executedSteps 已执行节点数。
 * @param maxSteps 最大节点数。
 * @param nodeId 当前节点。
 * @returns 超限时的结构化错误。
 */
export function ensureStepBudget(executedSteps: number, maxSteps: number, nodeId: string): WorkflowErrorDto | undefined {
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
 * 构建 workflow run DTO。
 *
 * @param input run 字段。
 * @returns workflow run DTO。
 */
export function buildRunDto(input: {
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
  error?: WorkflowErrorDto;
  partial?: boolean;
  recovery?: WorkflowRunDto["recovery"];
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
    error: input.error,
    partial: input.partial,
    recovery: input.recovery
  };
}

/**
 * 标准化 max steps，非法输入按 0 处理以触发结构化失败。
 *
 * @param maxSteps 调用方传入值。
 * @returns 可比较的整数。
 */
export function normalizeMaxSteps(maxSteps: number | undefined): number {
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
export function createWorkflowRunId(workflowName: string): string {
  const normalized = workflowName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `wf_${normalized || "run"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 计算耗时并保留两位小数。 */
export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
