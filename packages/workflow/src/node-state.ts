import type { WorkflowEdgeDto, WorkflowErrorDto, WorkflowNodeDto } from "@aiagent/types";
import type { AnyWorkflowNodeDefinition, WorkflowState } from "./types.js";

/**
 * 将节点定义初始化为 pending DTO，runtime 后续只更新 DTO 状态。
 *
 * @param definition 节点定义。
 * @returns pending node DTO。
 */
export function toPendingNodeDto(definition: AnyWorkflowNodeDefinition<WorkflowState>): WorkflowNodeDto {
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
export function createSequentialEdges(nodes: readonly AnyWorkflowNodeDefinition<WorkflowState>[]): WorkflowEdgeDto[] {
  return nodes.slice(0, -1).map((node, index) => ({
    from: node.nodeId,
    to: nodes[index + 1].nodeId
  }));
}

/**
 * 构造失败节点 DTO，保留 pending 节点被 max steps 截断的事实。
 *
 * @param node 原节点 DTO。
 * @param error 结构化错误。
 * @returns failed node DTO。
 */
export function failPendingNode(node: WorkflowNodeDto, error: WorkflowErrorDto): WorkflowNodeDto {
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
export function failRunningNode(
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

/** 计算耗时并保留两位小数。 */
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
