/**
 * Team 编排工具与宿主权限闸门之间的转发层（K3）。
 *
 * **v2.0 起 CLI 组合根不再使用本模块的 `createTeamToolset`**：Team 的唯一装配点是 serve
 * （`packages/serve/src/run/team-session.ts`，docs/v2.0/04 §2.2 / §7 第 1 步）。留在本文件的
 * 原因：`createTeamGateForwarder` 仍是「闸门未就绪即拒绝」这一策略的可读范例，且本模块被
 * `test/team-wiring.test.mjs` 直接覆盖。新增 Team 能力请改 serve 侧，不要回到这里。
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
  type AgentEvent,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
  type SubagentEventIdentity,
  type TeamState,
} from "@aiagent/agent";
import type { ConfirmHook } from "../permission/confirm.js";

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
  /**
   * 子代理共用的 streamFn（W3-6）：组合根注入带 LLM 采集的版本，子代理调用同样产生
   * `llm_call` 记录；缺省由 controller 用 `streamSimple`。
   */
  streamFn?: StreamFn;
  /**
   * 子代理边界事件转发（v2.0，docs/v2.0/04 §2.2）：缺省不转发。
   *
   * **注意**：CLI 组合根已不再调用本入口（Team 装配上移到 serve 的
   * `createServeTeamSession`）；本模块保留给仍自建 controller 的场景与单测。
   */
  onSubagentEvent?: (event: AgentEvent, identity: SubagentEventIdentity) => void;
}

/** 装配结果：待并入 supervisor 工具表的工具与来源标注集合。 */
export interface TeamToolset {
  /** TeamCreate / SendMessage（--no-team 时为空）。 */
  tools: AgentTool<any>[];
  /** 用于 /tools 标注「（Team）」的工具名。 */
  teamToolNames: Set<string>;
  /**
   * 团队状态读取器（G-T1 收敛，docs/v2.0/03-team-eval.md §9.1）：绑定 controller 实例的
   * `getTeamState`。组合根把它透传到 serve，run 收尾时用 `projectTeamCostSummary` 投影
   * `cost_summary.payload.team`——使 team 成本投影只有「serve 调 agent 纯函数」这一条路径。
   * `--no-team`（enabled=false）时**不带该键**，保持旧返回形状向后兼容。
   */
  getTeamState?: () => TeamState;
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
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
    // v2.0（docs/v2.0/04 §2.2）：子代理边界事件必须能转发出去，否则宿主看不到子代理。
    ...(options.onSubagentEvent ? { onSubagentEvent: options.onSubagentEvent } : {}),
  });
  return {
    tools: controller.tools,
    teamToolNames: new Set(controller.tools.map((tool) => tool.name)),
    // controller 引用不再丢弃：保留 getTeamState 作为成本投影入口（其余能力不进组合根）。
    getTeamState: () => controller.getTeamState(),
  };
}
