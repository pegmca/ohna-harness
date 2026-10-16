import type {
  WorkflowErrorDto,
  WorkflowEventDto,
  WorkflowNodeDto
} from "@aiagent/types";
import type {
  WorkflowEventSink,
  WorkflowNodeDefinition,
  WorkflowState
} from "./types.js";

/**
 * 经 sink 发出 workflow_node 事件，payload 与原 trace 事件本体同形状；
 * sink 是旁路观测能力，失败不影响 workflow 执行结果。
 *
 * @param sink 事件出口。
 * @param runId workflow run id。
 * @param definition 节点定义。
 * @param node 当前节点 DTO。
 * @param status 节点状态。
 * @param error 可选错误。
 * @returns sink 完成 Promise。
 */
export async function emitWorkflowNodeEvent(
  sink: WorkflowEventSink | undefined,
  runId: string,
  definition: WorkflowNodeDefinition<unknown, unknown, WorkflowState>,
  node: WorkflowNodeDto,
  status: WorkflowNodeDto["status"],
  error?: WorkflowErrorDto
): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink({
      type: "workflow_node",
      payload: {
        workflowRunId: runId,
        nodeId: definition.nodeId,
        nodeType: definition.type,
        status,
        durationMs: node.durationMs,
        inputSummary: node.inputSummary,
        outputSummary: node.outputSummary,
        error,
        createdAt: new Date().toISOString()
      }
    });
  } catch {
    // sink 是旁路观测能力，不能影响 workflow 执行结果。
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
export function createWorkflowEvent(
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
export function summarizeInput<TInput>(
  definition: WorkflowNodeDefinition<TInput, unknown, WorkflowState>,
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
export function summarizeOutput<TOutput>(
  definition: WorkflowNodeDefinition<unknown, TOutput, WorkflowState>,
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
export function summarizeValue(value: unknown): Record<string, unknown> {
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
