/**
 * team 评测指标：证据 → 得分（docs/v2.0/03-team-eval.md §7/§8）。
 *
 * 本模块是 team 评测的「领域语义层」，只认识 **TeamState / SubagentResult / 预算累加器**
 * 三类真相源（`TeamCaseEvidence` 已是它们的投影），不认识任何模型输出：
 * - 不含任何「模型应该选什么工具 / 派给谁」的断言（那是 L4 趋势，归 trend.ts）；
 * - 不对 `summary` 文本内容做匹配（只断言「非空」= 摘要回收通道走通）。
 *
 * 每个指标都有确定的 tier 与门禁归属，登记在 `TEAM_METRIC_SPECS`：
 * | 指标 | tier | 门禁 | 可确定性判定 |
 * |---|---|---|---|
 * | teamSubagentCompletionRate | T-L2b/T-L4 | hard | 是（status 计数） |
 * | teamPermissionInheritanceCorrectness | T-L1/T-L4 | hard | 是（工具子集 + 闸门裁决） |
 * | teamOverBudget | T-L1 | hard | 是（累加器严格 ≤ ceiling） |
 * | teamConvergence | T-L2b | hard | 是（预算/deadline 内收尾） |
 * | teamPeakConcurrency | T-L2b | hard | 是（峰值 ≤ 上限） |
 * | teamDispatchCorrectness | T-L4 | trend | 否（真模型决策） |
 * | teamCostAmplificationRatio | T-L4 | trend（soft/warn） | 否（叙事证据，永不 block） |
 * | teamTokenAttributionToMember | T-L4 | trend | 部分（usage 求和可复算，但依赖真 run） |
 *
 * 与 coding 指标的关系（§8）：指标名全部以 `team` 为前缀，与 coding 的
 * `fileChangeCorrectness` / `permissionCompliance` / `toolSelectionCorrectness` /
 * `turnEfficiency` 零交集，因此 team 报告的聚合值不可能被 coding 的 SLO 读到。
 */

import type { TeamMetricName, TeamMetricSpec } from "./types.js";

/**
 * §7 指标清单的可执行版本（唯一事实源：tier / 门禁归属 / 证据源 / 可确定性）。
 *
 * 顺序即报告中的指标顺序（稳定）。
 */
export const TEAM_METRIC_SPECS: readonly TeamMetricSpec[] = [
  {
    name: "teamContractStatuses",
    tier: "T-L1",
    gate: "hard",
    evidenceSource: "TeamState 终态 vs expectedMemberStatus / SubagentResult vs expectedResultStatus / 停止钩子实际轮数 vs maxTurns / 失败注入观测",
    deterministic: true,
    note: "把数据集里的 expectedMemberStatus / expectedResultStatus / maxTurns / failedMember 声明变成真断言（否则就是校验但不生效）",
  },
  {
    name: "teamL1Contract",
    tier: "T-L1",
    gate: "hard",
    evidenceSource: "extractSummary / classifyAborted / assembleSubagentConfig 的纯函数探针结果（evidence.l1）",
    deterministic: true,
    note: "仅 T-L1 档有证据；其余档 applicable=false（不把没测判成失败）",
  },
  {
    name: "teamDispatchCorrectness",
    tier: "T-L4",
    gate: "trend",
    evidenceSource: "supervisor tool_execution_* 投影成 TeamDispatchStep[] vs expectedSpawns/expectedSends",
    deterministic: false,
    note: "真模型决策质量，无 provider 凭据时显式 skip（trend 段记 skipped，不记 0 分）",
  },
  {
    name: "teamSubagentCompletionRate",
    tier: "T-L2b",
    gate: "hard",
    evidenceSource: "SubagentResult.status（done 数 / 派发总数）",
    deterministic: true,
    note: "无派发时 applicable=false（不进退化的 0/0）",
  },
  {
    name: "teamCostAmplificationRatio",
    tier: "T-L4",
    gate: "trend",
    evidenceSource: "cost_summary.team.totalCost vs 单 agent 等价 totalCost（评测侧取「最大单成员成本」作下界近似）",
    deterministic: false,
    note: "soft/warn：叙事证据而非正确性，永不 block（§7 末尾），归一化后作为趋势软阈值",
  },
  {
    name: "teamTokenAttributionToMember",
    tier: "T-L4",
    gate: "trend",
    evidenceSource: "members[].usage vs 成员逐轮 usage 之和（llm 记录，G-T3 有缺口）",
    deterministic: false,
    note: "成员内部分解的逐轮用量在评测侧不可得，只能用「非负且合计一致」的可复算弱断言",
  },
  {
    name: "teamPermissionInheritanceCorrectness",
    tier: "T-L1",
    gate: "hard",
    evidenceSource: "assembleSubagentConfig 继承通道 + 成员 allowedTools 子集裁决",
    deterministic: true,
    note: "fail-closed 是安全语义，硬门禁要求恒 1",
  },
  {
    name: "teamConvergence",
    tier: "T-L2b",
    gate: "hard",
    evidenceSource: "cost_summary.team.members[].budgetExceeded / durationMs",
    deterministic: true,
    note: "无成员运行时 applicable=false",
  },
  {
    name: "teamOverBudget",
    tier: "T-L1",
    gate: "hard",
    evidenceSource: "budgetExceeded + TeamBudgetAccumulator（严格 ≤ ceiling）",
    deterministic: true,
    note: "无预算上限配置的 case 不适用",
  },
  {
    name: "teamPeakConcurrency",
    tier: "T-L2b",
    gate: "hard",
    evidenceSource: "TeamState.peakConcurrency vs maxConcurrentMembers",
    deterministic: true,
    note: "无成员运行时 applicable=false",
  },
];

/** 指标名 → 规约的索引。 */
const SPEC_BY_NAME = new Map(TEAM_METRIC_SPECS.map((spec) => [spec.name, spec]));

/**
 * 查询单指标的静态规约（tier / 门禁归属）。
 *
 * @param name 指标名。
 * @returns 指标规约；未登记返回 undefined（调用方应视为编程错误）。
 */
export function getTeamMetricSpec(name: TeamMetricName): TeamMetricSpec | undefined {
  return SPEC_BY_NAME.get(name);
}

/** 该指标是否属于「硬门禁（block）」集合。 */
export function isHardGateMetric(name: TeamMetricName): boolean {
  return SPEC_BY_NAME.get(name)?.gate === "hard";
}

/** 该指标是否属于「趋势门禁（不 block）」集合。 */
export function isTrendMetric(name: TeamMetricName): boolean {
  return SPEC_BY_NAME.get(name)?.gate === "trend";
}

/** 硬门禁指标集合（供 index.ts 生成硬门禁 SLO 与 trend.ts 排除）。 */
export const HARD_GATE_METRICS: readonly TeamMetricName[] = TEAM_METRIC_SPECS.filter(
  (spec) => spec.gate === "hard",
).map((spec) => spec.name);

/** 趋势指标集合（只进趋势段，永不参与 exitCode）。 */
export const TREND_METRICS: readonly TeamMetricName[] = TEAM_METRIC_SPECS.filter(
  (spec) => spec.gate === "trend",
).map((spec) => spec.name);

/** `teamCostAmplificationRatio` 的 soft/warn 阈值（放大比超过即告警，绝不 block）。 */
export const COST_AMPLIFICATION_WARN_RATIO = 3;
