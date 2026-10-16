/**
 * 多代理团队成本 → RunEvent(cost_summary) 投影（P3 可观测闭环）。
 *
 * 设计取舍：trace 包在 CostSummaryEvent.payload 定义 `team` / `contextBudget` 两段的形状，
 * 但 trace 包**不得** import agent/ai（维持单向依赖）。因此本文件作为「投影层」落在 agent 包：
 * 提供纯函数把 agent 领域状态（TeamState / ContextBudgetReport[]）投影成**完全对齐** trace
 * 段的结构，run-service 在 agent_end 直接把投影结果并入 cost_summary.payload，无需反向依赖。
 */
import type { BudgetSummary, ContextBudgetReport } from "../context-assembly.js";
import type { TeamState } from "./types.js";
import { summarizeBudgetReports } from "../context-assembly.js";

/**
 * team 段单个成员成本（形状必须对齐 trace 的 CostSummaryEvent.payload.team.members）。
 * 字段顺序与语义与 trace 契约一致，run-service 可直接并入 payload。
 */
export interface TeamCostMember {
  /** 成员名称（消息总线寻址键）。 */
  name: string;
  /** 成员使用的模型 id（成本路由依据）。 */
  model: string;
  /** 该成员累计 token 数。 */
  tokens: number;
  /** 该成员累计成本（美元）。 */
  cost: number;
  /** 是否被成本护栏停止（超预算 / deadline）。 */
  budgetExceeded: boolean;
  /** 该成员本次运行墙钟时长（毫秒），多代理时延归因用；未跑过时缺省。 */
  durationMs?: number;
}

/**
 * team 段成本汇总（形状必须对齐 trace 的 CostSummaryEvent.payload.team）。
 */
export interface TeamCostSection {
  /** 各成员成本明细。 */
  members: TeamCostMember[];
  /** 团队成员 token 合计。 */
  totalTokens: number;
  /** 团队成员成本合计。 */
  totalCost: number;
  /**
   * 本次团队运行观测到的在飞成员峰值（多代理并发/容量证据）。来自 controller 维护的
   * runningMembers 在飞数峰值；未实际并发（maxConcurrentMembers=1）时缺省。
   */
  peakConcurrency?: number;
}

/**
 * 把 TeamState 投影成 cost_summary 的 team 段（纯函数、可单测）。
 *
 * 防御式读取：每个成员的 `usage`（tokens / cost）若缺失或非有限数，按 0 处理；无 usage 的成员
 * 仍保留在成员列表（便于看板展示「未产生用量的成员」）。`budgetExceeded` 缺失视为 false。
 * 累加在纯函数内完成，不 mutate 入参（teamState 本就是浅拷贝快照）。
 *
 * @param teamState 团队状态快照（controller.getTeamState() 返回值）。
 * @returns 完全对齐 trace team 段的结构，可直接并入 cost_summary.payload.team。
 */
export function projectTeamCostSummary(teamState: TeamState): TeamCostSection {
  const members: TeamCostMember[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  for (const [name, member] of teamState.members) {
    const usage = member.usage;
    // 防御式：usage 缺失或 tokens/cost 非有限 → 0，绝不抛异常（成本统计是观测数据）。
    const tokens = usage && Number.isFinite(usage.tokens) ? usage.tokens : 0;
    const cost = usage && Number.isFinite(usage.cost) ? usage.cost : 0;
    const budgetExceeded = member.budgetExceeded === true;
    // 成员时延：仅当为有限数才回填（未跑过/缺失 → undefined），不污染既有事件形状。
    const durationMs =
      member.durationMs !== undefined && Number.isFinite(member.durationMs) ? member.durationMs : undefined;
    members.push({ name, model: member.model.id, tokens, cost, budgetExceeded, ...(durationMs !== undefined ? { durationMs } : {}) });
    totalTokens += tokens;
    totalCost += cost;
  }
  // 团队并发峰值：仅当为有限数才并入（缺省表示本次未实际并发）。
  const peakConcurrency =
    teamState.peakConcurrency !== undefined && Number.isFinite(teamState.peakConcurrency)
      ? teamState.peakConcurrency
      : undefined;
  return { members, totalTokens, totalCost, ...(peakConcurrency !== undefined ? { peakConcurrency } : {}) };
}

/**
 * 把多份 ContextBudgetReport 投影成 cost_summary 的 contextBudget 段。
 *
 * 直接复用 context-assembly 的 `summarizeBudgetReports`（聚合逻辑单一来源，避免重复实现），
 * 仅做形状对齐：返回的 BudgetSummary 字段（count / averageMemoryHitRate / averageDiscardRate /
 * overBudgetCount / discardedCount）与 trace 的 contextBudget 段一一对应。
 *
 * @param reports 多次 transform 产出的预算指标（顺序无关）。
 * @returns 完全对齐 trace contextBudget 段的结构。
 */
export function projectContextBudgetSummary(reports: ContextBudgetReport[]): BudgetSummary {
  return summarizeBudgetReports(reports);
}
