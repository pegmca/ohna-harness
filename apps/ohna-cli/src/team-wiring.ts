/**
 * Team 编排工具与宿主权限闸门之间的转发层（K3）。
 *
 * 时序问题：team controller 必须先于 REPL 创建（工具要并入工具表），而真正的闸门依赖
 * REPL/单次模式内部的 readline/TUI 实例，只能后建。组合根因此用一个可变引用 `gateRef`
 * 桥接：controller 拿到的是本模块的转发闭包，闸门就绪后再把引用指向真实钩子。
 *
 * 安全取舍（fail-closed）：闸门尚未回填时**拒绝**而不是放行。`runMember` 是公共 API，
 * 未来若新增入口漏掉 `onGateReady` 回调，fail-open 会静默绕过所有审批；fail-closed 只会
 * 让子代理操作失败并回喂结构化原因，可观测且不会越权。
 */
import type { Api, Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import {
  createTeamController,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@aiagent/agent";
import type { ConfirmHook } from "./confirm.js";

/** 转发闭包的签名，与 `AgentLoopConfig.beforeToolCall` 一致。 */
export type TeamGateForwarder = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/**
 * 创建权限闸门转发器：每次调用实时读取可变引用，未就绪时返回 block。
 *
 * @param getGate 读取当前已装配的权限闸门（未就绪返回 undefined）。
 * @returns 可直接注入 team controller 的 `beforeToolCall`。
 */
export function createTeamGateForwarder(getGate: () => ConfirmHook | undefined): TeamGateForwarder {
  return async (context, signal) => {
    const gate = getGate();
    if (!gate) {
      return { block: true, reason: "权限闸门未就绪，已拒绝子代理操作。" };
    }
    return gate(context, signal);
  };
}

/** 团队工具集的装配参数。 */
export interface TeamToolsetOptions {
  /** 是否启用团队编排（--no-team 时为 false）。 */
  enabled: boolean;
  /** 子代理可继承的编码工具池（快照：不含 MCP / team 自身）。 */
  codingTools: readonly AgentTool<any>[];
  /** 子代理默认模型（启动时快照）。 */
  defaultModel: Model<Api>;
  /** 读取当前权限闸门（可变引用；未就绪时转发器 fail-closed）。 */
  getGate: () => ConfirmHook | undefined;
}

/** 装配结果：待并入 supervisor 工具表的工具与来源标注集合。 */
export interface TeamToolset {
  /** TeamCreate / SendMessage（--no-team 时为空）。 */
  tools: AgentTool<any>[];
  /** 用于 /tools 标注「（Team）」的工具名。 */
  teamToolNames: Set<string>;
}

/**
 * 按开关装配团队工具集：`enabled=false` 时返回空集合，宿主不注册任何 team 工具。
 *
 * @param options 开关、编码工具池快照、默认模型与闸门读取器。
 * @returns 团队工具与来源标注集合。
 */
export function createTeamToolset(options: TeamToolsetOptions): TeamToolset {
  if (!options.enabled) return { tools: [], teamToolNames: new Set() };
  const controller = createTeamController({
    availableTools: [...options.codingTools],
    defaultModel: options.defaultModel,
    beforeToolCall: createTeamGateForwarder(options.getGate),
  });
  return {
    tools: controller.tools,
    teamToolNames: new Set(controller.tools.map((tool) => tool.name)),
  };
}
