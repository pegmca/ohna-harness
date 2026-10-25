/**
 * team 评测的共享装配 helper（低层模块，零自身上层依赖）。
 *
 * 从 `run.ts` 抽出，专为解决 `run.ts ↔ run-provider.ts` 的循环依赖：
 * 两个执行器都需要「默认工具池 / 空证据 / 评测模型 / 成员播种 / controller 快照投影 /
 * 预算预检投影」这批纯装配逻辑，放在本文件后二者都只单向依赖这里，
 * 彼此不再互相引用（AGENTS.md：保持依赖单向，避免循环依赖）。
 *
 * 本文件只做**装配与投影**，不做断言：断言归属各自的执行器（run.ts / run-provider.ts）。
 */

import { createTeamController, type StreamFn } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import type { Api, Model } from "@aiagent/ai";
import { createRecordingGate } from "./adapter.js";
import type { TeamCaseEvidence, TeamControllerHandle, TeamEvalCase, TeamExpectedMember } from "./types.js";

/** 默认可用工具池（与 adapter 的 `DEFAULT_TEAM_TOOL_POOL` 一致）。 */
export const DEFAULT_POOL = ["read", "write", "edit", "bash"] as const;

/**
 * 构造空证据（未执行 / skip 档）。
 *
 * @param maxConcurrentMembers 本 case 的并发上限。
 * @returns 全零证据（`executed:false`）。
 */
export function emptyEvidence(maxConcurrentMembers: number): TeamCaseEvidence {
  return {
    executed: false,
    memberStatus: {},
    spawnedMembers: [],
    sends: [],
    toolTrajectory: [],
    subagentResults: [],
    deniedTools: [],
    grantedToolsByMember: {},
    teamUsage: { totalTokens: 0, totalCost: 0 },
    budgetExceeded: false,
    peakConcurrency: 0,
    maxConcurrentMembers,
    memberUsage: {},
  };
}

/**
 * 评测专用模型：真 provider 的最小驱动（小 `maxTokens`，低成本、快收敛）。
 *
 * @param base 凭据解析出的模型。
 * @returns 缩减输出上限后的模型副本。
 */
export function toEvalModel(base: Model<Api>): Model<Api> {
  return { ...base, maxTokens: Math.min(base.maxTokens, 512) };
}

/**
 * 按 case 声明创建成员（预置成员与期望 spawn 走同一 `createMember` 路径）。
 *
 * @param controller controller 句柄。
 * @param members 成员声明。
 * @param toolTrajectory 编排原语轨迹（记录 TeamCreate 调用事实）。
 */
export function seedMembers(
  controller: TeamControllerHandle,
  members: readonly TeamExpectedMember[],
  toolTrajectory: TeamCaseEvidence["toolTrajectory"],
): void {
  for (const member of members) {
    if (controller.hasMember(member.name)) continue;
    controller.createMember({
      name: member.name,
      role: member.role ?? `team-eval 成员 ${member.name}`,
      ...(member.allowedTools ? { tools: member.allowedTools } : {}),
    });
    toolTrajectory.push({ tool: "TeamCreate", args: { name: member.name } });
  }
}

/**
 * 从 controller 快照投影证据的公共字段（成员状态 / 工具子集 / 团队用量 / 并发峰值）。
 *
 * 工具子集用**评测侧独立复算**（`pool ∩ allowedTools`）而不是读 controller 内部解析结果，
 * 使「controller 的过滤逻辑回归」能被 `teamPermissionInheritanceCorrectness` 抓到。
 *
 * @param controller controller 句柄。
 * @param pool 可用工具名池。
 * @param maxConcurrentMembers 本 case 并发上限。
 * @returns 证据公共字段。
 */
export function projectControllerFacts(
  controller: TeamControllerHandle,
  pool: readonly string[],
  maxConcurrentMembers: number,
): Pick<TeamCaseEvidence, "memberStatus" | "grantedToolsByMember" | "teamUsage" | "peakConcurrency" | "maxConcurrentMembers"> {
  const state = controller.getTeamState();
  const memberStatus: TeamCaseEvidence["memberStatus"] = {};
  const grantedToolsByMember: Record<string, string[]> = {};
  for (const [name, member] of state.members) {
    memberStatus[name] = member.status;
    grantedToolsByMember[name] =
      member.allowedTools === undefined ? [...pool] : pool.filter((tool) => member.allowedTools?.includes(tool));
  }
  return {
    memberStatus,
    grantedToolsByMember,
    teamUsage: { ...controller.getBudgetAccumulator() },
    peakConcurrency: state.peakConcurrency ?? 0,
    maxConcurrentMembers,
  };
}

/**
 * 构造 team controller（统一装配权限继承闸门 / 并发上限 / 成本护栏 / 真实 streamFn）。
 *
 * @param case_ 评测 case。
 * @param tools 可用工具池（已 mock 副作用）。
 * @param options.streamFn 真实 streamFn（T-L1/T-L2a 不传 = 子代理永远不会跑）。
 * @param options.model 成员默认模型（不传时 T-L1/T-L2a 用占位模型，因为不会有模型调用）。
 * @param options.denials 拒绝记录数组（继承闸门写入）。
 * @returns controller 句柄。
 */
export function buildController(
  case_: TeamEvalCase,
  tools: AgentTool[],
  options: { streamFn?: StreamFn; model?: Model<Api>; denials: string[] },
): TeamControllerHandle {
  return createTeamController({
    availableTools: tools,
    // T-L1/T-L2a 不会有模型调用；占位模型只满足类型与构造契约（不会触达网络）。
    defaultModel: (options.model ?? ({ id: "team-eval-placeholder", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>)),
    maxConcurrentMembers: case_.maxConcurrentMembers ?? 1,
    beforeToolCall: createRecordingGate(options.denials, { deniedTools: case_.expectedPermission?.deniedTools ?? [] }),
    ...(case_.maxTokensTotal !== undefined || case_.maxCostPerMember !== undefined
      ? {
          budget: {
            ...(case_.maxTokensTotal !== undefined ? { maxTokensTotal: case_.maxTokensTotal } : {}),
            ...(case_.maxCostPerMember !== undefined ? { maxCostPerMember: case_.maxCostPerMember } : {}),
          },
        }
      : {}),
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
  });
}


/**
 * 从派发观测推导「派发前预算预检」的证据。
 *
 * 推导规则（全部来自真实 `SubagentResult`，不合成）：
 * - `checked`：带 `estimatedTokens` 且成员存在的派发数（预检只在预算配置 + 估算值都存在时发生）；
 * - `rejected`：返回 `error.code === "budget_exceeded"` 的派发数；
 * - `drivenAfterReject`：被判拒绝却仍带 `usage.tokens > 0` 的成员数（预检被穿透的硬失败信号）。
 *
 * @param sends 实际派发的 `{ recipient, estimatedTokens }` 列表。
 * @param sendsWithEstimate 带估算值的派发数。
 * @param results 成员执行结果。
 * @returns 预检证据（无预算相关的派发时为 undefined）。
 */
export function projectBudgetPrecheck(
  sendsWithEstimate: number,
  results: readonly { member: string; errorCode?: string; tokens?: number }[],
): TeamCaseEvidence["budgetPrecheck"] {
  if (sendsWithEstimate === 0) return undefined;
  const rejected = results.filter((result) => result.errorCode === "budget_exceeded");
  return {
    checked: sendsWithEstimate,
    rejected: rejected.length,
    // 被拒绝的成员若还消耗了 token，说明它其实被驱动了（预检形同虚设）。
    drivenAfterReject: rejected.filter((result) => (result.tokens ?? 0) > 0).length,
  };
}

