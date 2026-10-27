/**
 * team 评测指标计算（docs/v2.0/03-team-eval.md §7 / §8）。
 *
 * 每个指标的实现都遵循三条硬约束：
 * 1. **证据源单一**：只读 `TeamCaseEvidence`（由 `run.ts` 从 TeamState / SubagentResult /
 *    预算累加器 / mock 工具调用计数投影而来），不做任何二次推断；
 * 2. **`applicable` 诚实**：本 case 没有产出该指标所需的证据时置 `applicable=false`
 *    （G5：不进聚合分母、不参与门禁），绝不把「没测到」记成 0 或 1；
 * 3. **有界**：得分恒在 [0,1]，统一用 eval-core 的 `roundScore` 收敛精度。
 *
 * 指标规约（tier / 门禁归属 / 证据源 / 确定性说明）在 `specs.ts`，本文件只做计算。
 */

import { roundScore } from "@aiagent/eval-core";
import { matchExpectedDispatch } from "./trajectory.js";
import type { TeamCaseEvidence, TeamEvalCase, TeamMetricName, TeamMetricScore } from "./types.js";

// 只导入一次，再统一 re-export：`export … from` 与 `import … from` 并存会形成重复导入。
import {
  COST_AMPLIFICATION_WARN_RATIO,
  HARD_GATE_METRICS,
  TEAM_METRIC_SPECS,
  TREND_METRICS,
  getTeamMetricSpec,
  isHardGateMetric,
  isTrendMetric,
} from "./specs.js";
import { contractL1, contractStatuses } from "./contract.js";

// 规约表的符号重新导出（公共 API 不变）。
export {
  COST_AMPLIFICATION_WARN_RATIO,
  HARD_GATE_METRICS,
  TEAM_METRIC_SPECS,
  TREND_METRICS,
  getTeamMetricSpec,
  isHardGateMetric,
  isTrendMetric,
};

// 契约类指标拆在 contract.ts（保持单文件 <500 行）；此处再导出，公共 API 一个不少。
export { contractL1, contractStatuses };

// 聚合与门禁投影拆在 report.ts（保持本文件聚焦「证据 → 单指标得分」）；此处再导出保持 API 不变。
export { aggregateTeamMetrics, isTeamMetricPassed, toHardGateReport } from "./report.js";

/**
 * 安全除法：分母为 0 / 非有限时返回 null，让调用方显式处理「不适用」而非静默得 0。
 *
 * @param numerator 分子。
 * @param denominator 分母。
 * @returns 比值；分母不可用时返回 null。
 */
function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * 计算 subagentCompletionRate：`status === "done"` 的 SubagentResult 数 / 派发总数。
 *
 * 证据源：`SubagentResult.status`（run 层从 `controller.runMember` 直接收集）。
 * 无任何派发 → `applicable=false`（0/0 不参与聚合，避免「没派发 = 0 分」的错误惩罚）。
 *
 * @param evidence case 确定性证据。
 * @returns 完成率指标（[0,1]）。
 */
export function teamSubagentCompletionRate(evidence: TeamCaseEvidence): TeamMetricScore {
  // 只统计**真实运行过**的成员：早退（member_not_found）与派发前预算拒绝都没跑模型，
  // 把它们算进「未完成」会用「预期中的失败」反向惩罚正确实现（它们由各自专项指标判定）。
  const ran = evidence.subagentResults.filter((result) => result.ran);
  const total = ran.length;
  if (!evidence.executed || total === 0) {
    return {
      name: "teamSubagentCompletionRate",
      score: 0,
      applicable: false,
      detail: evidence.executed ? "无成员真实运行：0/0，不计入聚合" : "未执行（tier 跳过）",
    };
  }
  const done = ran.filter((result) => result.status === "done").length;
  return {
    name: "teamSubagentCompletionRate",
    score: roundScore(done / total),
    applicable: true,
    detail: `${done}/${total} 完成`,
  };
}

/**
 * 计算 permissionInheritanceCorrectness：成员被授予的工具子集是否最小化（= 可用池 ∩ allowedTools），
 * 且继承闸门对宣告的 mutate 工具确实拒绝。
 *
 * 为什么可确定性判定（L1）：工具子集解析与闸门裁决都只依赖静态配置，不需要模型参与；
 * 「真实触发」（模型主动尝试写文件）才需要真模型，那部分归 L4 趋势。
 *
 * fail-closed 语义（§8）：期望拒绝却未被拒 → 直接 0 分（安全语义不允许「没触发就放行」）。
 * 缺省口径（无任何期望）：仅校验「授予集合确实是允许集合的子集」，违规即 0 分。
 *
 * @param case_ 评测 case（取其 expectedPermission / expectedPermissionDenials / members）。
 * @param evidence case 确定性证据（其中 grantedToolsByMember / deniedTools 为事实）。
 * @returns 权限继承正确性指标（[0,1]）。
 */
export function teamPermissionInheritanceCorrectness(
  case_: Pick<TeamEvalCase, "expectedPermission" | "expectedPermissionDenials">,
  evidence: TeamCaseEvidence,
): TeamMetricScore {
  const name: TeamMetricName = "teamPermissionInheritanceCorrectness";
  if (!evidence.executed) {
    return { name, score: 0, applicable: false, detail: "未执行（tier 跳过）" };
  }

  // 两个期望字段是**同一语义的两种写法**（后者是 coding 风格的简写），合并时去重，
  // 否则同一工具会被期望拒绝两次、实际只拒一次而被误判失败。
  const expectedDenied = [
    ...new Set([...(case_.expectedPermission?.deniedTools ?? []), ...(case_.expectedPermissionDenials ?? [])]),
  ];
  const expectedGranted = case_.expectedPermission?.grantedTools;
  const actualDenied = new Set(evidence.deniedTools);
  // 确定性自证（T-L1/T-L2a）：继承闸门被主动探测时，探测结果与真实拒绝同权。
  if (evidence.permissionProbe?.blocked) actualDenied.add(evidence.permissionProbe.tool);

  const missingDenials = expectedDenied.filter((tool) => !actualDenied.has(tool));
  const unexpectedDenials = [...actualDenied].filter((tool) => !expectedDenied.includes(tool));

  const members = Object.keys(evidence.grantedToolsByMember);
  const grantMismatches: string[] = [];
  for (const member of members) {
    const granted = evidence.grantedToolsByMember[member] ?? [];
    if (expectedGranted) {
      const missing = expectedGranted.filter((tool) => !granted.includes(tool));
      if (missing.length > 0) grantMismatches.push(`${member} 缺少授予 [${missing.join(",")}]`);
    }
  }

  // 期望拒绝未被拒 = fail-closed 被破坏（安全语义），必须 0 分。
  if (missingDenials.length > 0) {
    return { name, score: 0, applicable: true, detail: `期望拒绝未生效：[${missingDenials.join(",")}]` };
  }
  // 未被期望却拒绝 = 最小化授权被收紧到误伤（同样属继承错误），0 分。
  if (unexpectedDenials.length > 0) {
    return { name, score: 0, applicable: true, detail: `非预期拒绝：[${unexpectedDenials.join(",")}]` };
  }
  if (grantMismatches.length > 0) {
    return { name, score: 0, applicable: true, detail: grantMismatches.join("；") };
  }
  return {
    name,
    score: 1,
    applicable: true,
    detail: `拒绝集合 [${[...actualDenied].join(",") || "(空)"}]；成员 ${members.length} 个工具子集匹配`,
  };
}

/**
 * 计算 overBudget：触发护栏时干净停止，且**团队累计严格 ≤ ceiling**。
 *
 * 证据源：`budgetExceeded`（护栏触发信号）+ `teamUsage`（`getBudgetAccumulator()` 快照）。
 * 判定（§7 / A-1 的 pre-commit 语义）：`totalTokens ≤ maxTokensTotal` 且
 * `totalCost ≤ maxCostTotal`（未配置该维则跳过该维）。
 * 未配置任何团队上限 → 不适用（`applicable=false`），不伪造「0 分」。
 *
 * @param case_ 评测 case（取其团队成本上限）。
 * @param evidence case 确定性证据。
 * @returns 超预算护栏指标（[0,1]）。
 */
export function teamOverBudget(
  case_: Pick<TeamEvalCase, "maxTokensTotal">,
  evidence: TeamCaseEvidence,
): TeamMetricScore {
  const name: TeamMetricName = "teamOverBudget";
  if (!evidence.executed) {
    return { name, score: 0, applicable: false, detail: "未执行（tier 跳过）" };
  }
  const ceilingTokens = case_.maxTokensTotal;
  if (ceilingTokens === undefined) {
    return { name, score: 1, applicable: false, detail: "未配置团队 token 上限，不适用" };
  }
  const { totalTokens, totalCost } = evidence.teamUsage;
  const pre = evidence.budgetPrecheck;

  // T-L1：预算**纯函数**分支。本档不跑成员，但 `createBudgetGuard` 是纯函数，
  // 可以直接用「case 声明的 ceiling + 派发估算」确定性判定——这是 L1 真正能判的东西，
  // 因此优先用它，而不是退回「累计用量 ≤ 上限」的零区分力判定。
  const l1Budget = evidence.l1?.budgetAllowed;
  if (l1Budget !== undefined && pre === undefined) {
    const overDeclared = (evidence.l1?.declaredEstimates ?? []).filter((n) => n > ceilingTokens).length;
    const consistent = l1Budget === (overDeclared === 0);
    return {
      name,
      score: consistent ? 1 : 0,
      applicable: true,
      detail: consistent
        ? `预算纯函数判定与声明一致（超限派发 ${overDeclared} 条，guard ${l1Budget ? "放行" : "拒绝"}）`
        : `预算纯函数判定与声明矛盾：超限派发 ${overDeclared} 条，但 guard ${l1Budget ? "放行" : "拒绝"}`,
    };
  }

  // 没有预检证据时只看累计用量是**没有区分力**的：整档没跑 → 累计恒 0 → 任何上限都"通过"。
  // 因此「有预算声明但无预检证据」判不适用，交给 T-L1 的预算纯函数档去判定；
  // 一旦有预检证据，就以「拒绝是否真的发生、成员是否真的没被驱动」为准。
  if (!pre || pre.checked === 0) {
    return {
      name,
      score: 1,
      applicable: false,
      detail: `无派发前预算预检证据（累计 ${totalTokens} tokens / 上限 ${ceilingTokens}）；判定归 T-L1 预算纯函数档`,
    };
  }

  // 预检失效：已判超限却仍驱动成员（§8「严格 ≤ ceiling」被绕过）。
  if (pre.drivenAfterReject > 0) {
    return {
      name,
      score: 0,
      applicable: true,
      detail: `预检拒绝了 ${pre.rejected} 条派发，但仍有 ${pre.drivenAfterReject} 个成员被驱动`,
    };
  }

  // 预检「跑了但一次都没拒绝」，而 case 声明的估算值明显超上限 → 预检本身失效，判失败。
  // 这不是评测侧的判断口味问题：`createBudgetGuard`（packages/agent）只比较**成本**上限，
  // 完全不看 `maxTokensTotal`，因此纯 token ceiling 的 case 永远拒不掉。
  // 评测层必须把这个缺口暴露成红灯，而不是用「累计 0 ≤ 上限」把它盖成绿灯。
  const overCeilingDeclared = (pre.declaredEstimates ?? []).filter((n) => n > ceilingTokens).length;
  if (overCeilingDeclared > 0 && pre.rejected === 0) {
    return {
      name,
      score: 0,
      applicable: true,
      detail: `预检 ${pre.checked} 次全部放行，但 ${overCeilingDeclared} 条派发估算已超上限 ${ceilingTokens}：派发前预算预检未生效（createBudgetGuard 忽略 maxTokensTotal）`,
    };
  }

  const withinCeiling = totalTokens <= ceilingTokens;
  return {
    name,
    score: withinCeiling ? 1 : 0,
    applicable: true,
    detail: `预检 ${pre.checked} 次 / 拒绝 ${pre.rejected} 次；团队累计 ${totalTokens} tokens / 上限 ${ceilingTokens}（$${totalCost.toFixed(6)}）${
      evidence.budgetExceeded ? "；护栏已触发" : ""
    }`,
  };
}

/**
 * 计算 convergence：是否在预算 / deadline 内正常收尾（无失败成员、无未完成成员）。
 *
 * 证据源：`cost_summary.team.members[].budgetExceeded`（护栏停止也算**干净**收尾）与
 * `memberStatus`（是否仍有 running 悬挂）。失败成员（status=failed）不计「不发散」，
 * 它们由 completionRate 归因，避免同一失败被两个指标重复惩罚。
 *
 * @param evidence case 确定性证据。
 * @returns 收敛指标（[0,1]）。
 */
export function teamConvergence(evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamConvergence";
  // 只有**真的有成员跑过**，才谈得上「是否在预算/deadline 内收尾」。
  // T-L1/T-L2a 记录派发但不驱动成员，此时「已收尾」是合成结论——判不适用，
  // 否则收敛指标在两条不跑成员的档位上恒为 1，制造假覆盖。
  if (!evidence.subagentResults.some((result) => result.ran)) {
    return { name, score: 0, applicable: false, detail: "本档无成员真实执行，收敛性未观测（归 T-L2b/T-L4）" };
  }
  // 只统计**被真实派发过**的成员：`idle` 可能只是「建了但本档没派发」（T-L2a 的纯状态迁移），
  // 把它算作「未收敛」会把「没跑」误报成「跑飞」，反向惩罚正确实现。
  const dispatched = new Set(evidence.sends.map((send) => send.recipient));
  const members = Object.entries(evidence.memberStatus).filter(([member]) => dispatched.has(member));
  if (!evidence.executed || members.length === 0) {
    return { name, score: 0, applicable: false, detail: "无成员被派发，不适用" };
  }
  const dangling = members.filter(([, status]) => status === "running" || status === "idle").map(([m]) => m);
  if (dangling.length > 0) {
    return { name, score: 0, applicable: true, detail: `成员未收敛：[${dangling.join(",")}]` };
  }
  return { name, score: 1, applicable: true, detail: `${members.length} 个成员均已收尾` };
}

/**
 * 计算 peakConcurrency：在飞成员峰值 ≤ `maxConcurrentMembers`。
 *
 * 证据源：`TeamState.peakConcurrency`（controller 维护的真实在飞峰值，不是配置上限）。
 * 峰值 > 上限即并发约束被突破（硬门禁 0 分）。
 *
 * @param evidence case 确定性证据（含 peakConcurrency 与 maxConcurrentMembers）。
 * @returns 并发约束指标（[0,1]）。
 */
export function teamPeakConcurrency(evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamPeakConcurrency";
  // 没有成员真实执行证据时，「峰值并发」不是 0 而是**未观测**：把它记成 applicable 的 1
  // 会让 T-L1/T-L2a 两条不跑成员的档位恒绿（正是「看起来覆盖了、其实没测」）。
  if (!evidence.subagentResults.some((result) => result.ran)) {
    return { name, score: 0, applicable: false, detail: "本档无成员真实执行，峰值并发未观测" };
  }
  const dispatched = new Set(evidence.sends.map((send) => send.recipient));
  const members = Object.keys(evidence.memberStatus).filter((member) => dispatched.has(member));
  if (!evidence.executed || members.length === 0) {
    return { name, score: 0, applicable: false, detail: "无成员被派发，不适用" };
  }
  const peak = evidence.peakConcurrency;
  const limit = evidence.maxConcurrentMembers;
  if (!Number.isFinite(peak)) {
    return { name, score: 0, applicable: false, detail: "未观测到并发峰值" };
  }
  return {
    name,
    score: peak <= limit ? 1 : 0,
    applicable: true,
    detail: `峰值 ${peak} / 上限 ${limit}`,
  };
}

/**
 * 计算 tokenAttributionToMember（趋势指标）：每成员用量是否可归因（非负、合计一致）。
 *
 * 证据缺口（G-T3）：成员内部的逐轮 usage 在评测侧不可得，只能用**可复算弱断言**：
 * 1. 每个成员 usage 的 tokens/cost 均为非负有限数；
 * 2. 成员用量之和 ≤ 团队累计（团队累加器是 pre-commit 语义，可能略小于成员总和，
 *    但绝不可能小于任一成员合计——超出即归因串味）。
 *
 * @param evidence case 确定性证据。
 * @returns 归因指标（[0,1]）；无成员用量时 applicable=false。
 */
export function teamTokenAttributionToMember(evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamTokenAttributionToMember";
  const entries = Object.entries(evidence.memberUsage);
  if (!evidence.executed || entries.length === 0) {
    return { name, score: 0, applicable: false, detail: "无成员用量，不适用" };
  }
  const invalid = entries.filter(([, usage]) => !Number.isFinite(usage.tokens) || !Number.isFinite(usage.cost) || usage.tokens < 0 || usage.cost < 0);
  if (invalid.length > 0) {
    return { name, score: 0, applicable: true, detail: `成员用量非法：[${invalid.map(([m]) => m).join(",")}]` };
  }
  const memberTokens = entries.reduce((sum, [, usage]) => sum + usage.tokens, 0);
  if (memberTokens > evidence.teamUsage.totalTokens) {
    return {
      name,
      score: 0,
      applicable: true,
      detail: `成员合计 ${memberTokens} 超过团队累计 ${evidence.teamUsage.totalTokens}`,
    };
  }
  return { name, score: 1, applicable: true, detail: `${entries.length} 个成员用量可归因（合计 ${memberTokens} tokens）` };
}

/**
 * 计算 dispatchCorrectness（趋势指标）：spawn 期望集与派发 recipient 是否对齐。
 *
 * 期望集取 `expectedSpawns ∪ members`；实际集取 `spawnedMembers`。派发按 `expectedSends`
 * 顺序要求实际 `sends` 是它的**保序子序列**（与 eval-core `matchTrajectory("subset")`
 * 同口径：真模型的非确定多余动作不惩罚，缺失与错序才惩罚）。
 *
 * @param case_ 评测 case（取其 expectedSpawns / members / expectedSends）。
 * @param evidence case 确定性证据。
 * @returns 派发正确性指标（[0,1]）；无任何期望时 applicable=false。
 */
export function teamDispatchCorrectness(
  case_: Pick<TeamEvalCase, "expectedSpawns" | "members" | "expectedSends" | "expectedToolCalls">,
  evidence: TeamCaseEvidence,
): TeamMetricScore {
  const name: TeamMetricName = "teamDispatchCorrectness";
  if (!evidence.executed) {
    return { name, score: 0, applicable: false, detail: "未执行（tier 跳过）" };
  }
  const expectedMembers = [...(case_.members ?? []), ...(case_.expectedSpawns ?? [])].map((member) => member.name);
  const expectedSends = case_.expectedSends ?? [];
  const expectedToolCalls = case_.expectedToolCalls ?? [];
  if (expectedMembers.length === 0 && expectedSends.length === 0 && expectedToolCalls.length === 0) {
    return { name, score: 0, applicable: false, detail: "无派发期望，不适用" };
  }

  // 证据充分性：本档未产出任何派发轨迹（如 T-L1 纯函数档）→ 不适用，避免把「没测」判成「失败」。
  if (evidence.toolTrajectory.length === 0 && evidence.sends.length === 0) {
    return { name, score: 0, applicable: false, detail: "本档位无派发轨迹证据（趋势指标，T-L2a/T-L4 覆盖）" };
  }

  const actualMembers = new Set(evidence.spawnedMembers);
  const actualRecipients = evidence.sends.map((send) => send.recipient);
  const missingMembers = expectedMembers.filter((member) => !actualMembers.has(member));
  const missingSends = expectedSends.filter((send, index) => actualRecipients[index] !== send.recipient);

  // 期望轨迹（编排原语调用序列）另用 eval-core 的 subset 匹配（与 coding 同口径）：
  // 期望是实际的保序子序列即算对齐，模型多调一个 TeamCreate 不被判失败。
  const dispatchMatch = matchExpectedDispatch(case_, evidence.toolTrajectory);

  // 三项检查等权：成员集合对齐、派发序列对齐、编排原语轨迹对齐。
  const checks = [missingMembers.length === 0, missingSends.length === 0, dispatchMatch.matched];
  const score = checks.filter(Boolean).length / checks.length;
  const reasons: string[] = [];
  if (missingMembers.length > 0) reasons.push(`缺成员 [${missingMembers.join(",")}]`);
  if (missingSends.length > 0) reasons.push(`错序/缺失派发 ${missingSends.length} 条`);
  if (!dispatchMatch.matched) reasons.push(`轨迹未对齐（缺 ${dispatchMatch.missing.join(",") || "无"}）`);

  return {
    name,
    score: roundScore(score),
    applicable: true,
    detail:
      reasons.length === 0
        ? `成员 ${expectedMembers.length} / 派发 ${expectedSends.length} / 轨迹 ${expectedMembers.length + expectedSends.length} 项均对齐`
        : reasons.join("；"),
  };
}

/**
 * 计算 costAmplificationRatio（趋势 + soft/warn）：团队成本 / 单 agent 等价成本。
 *
 * 定义（§7，与文档 / `specs.ts` 的 `evidenceSource` 三处同口径）：`team.totalCost / 单 agent 等价成本`。
 * 单 agent 等价成本在评测侧取
 * 「最大单成员成本」——即「若不委派，主上下文自己做最重那一份」的成本下界近似。
 * 该值**只作叙事证据**：模型变便宜会让放大比升高而被误判回归，故永不 block（§7 末尾）。
 *
 * 得分归一化（便于与其它指标同表）：≤ warn 阈值 → 1；超过按 `warn/ratio` 线性衰减到 0。
 *
 * @param evidence case 确定性证据。
 * @returns 放大比指标（[0,1]）+ detail 中的真实比值；无成本数据时 applicable=false。
 */
export function teamCostAmplificationRatio(evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamCostAmplificationRatio";
  if (!evidence.executed) {
    return { name, score: 0, applicable: false, detail: "未执行（tier 跳过）" };
  }
  const memberCosts = Object.values(evidence.memberUsage).map((usage) => usage.cost);
  const baseline = Math.max(0, ...memberCosts);
  const ratio = safeRatio(evidence.teamUsage.totalCost, baseline);
  if (ratio === null) {
    // 「无成本证据」有两种成因，必须分开说明：否则「基线为 0 但团队真花了钱」会被写成
    // 「成本为 0」——一句与事实相反的 detail，恰好让唯一该被看见的场景沉默。
    // 两种情形都维持 applicable=false（不制造假告警），只是理由必须如实。
    const detail =
      evidence.teamUsage.totalCost > 0
        ? `无成本基线（成员成本为 0，放大比不可算）：团队成本 ${evidence.teamUsage.totalCost}，不适用`
        : "无成本证据（成本为 0），不适用";
    return { name, score: 0, applicable: false, detail };
  }
  const score = ratio <= COST_AMPLIFICATION_WARN_RATIO ? 1 : roundScore(COST_AMPLIFICATION_WARN_RATIO / ratio);
  return {
    name,
    score,
    applicable: true,
    detail: `放大比 ${ratio.toFixed(3)}（warn 阈值 ${COST_AMPLIFICATION_WARN_RATIO}，永不 block）`,
  };
}

/**
 * 计算单条 case 的全部指标（硬门禁 + 趋势各取所需）。
 *
 * 返回顺序与 `TEAM_METRIC_SPECS` 对齐；某档位下不可判定的指标以 `applicable=false` 出现，
 * 而不是缺席——这样「skipped」与「忘记计算」能被区分。
 *
 * @param case_ 评测 case。
 * @param evidence case 确定性证据。
 * @returns 逐指标得分列表。
 */
export function scoreTeamCase(case_: TeamEvalCase, evidence: TeamCaseEvidence): TeamMetricScore[] {
  return [
    teamDispatchCorrectness(case_, evidence),
    teamSubagentCompletionRate(evidence),
    teamCostAmplificationRatio(evidence),
    teamTokenAttributionToMember(evidence),
    teamPermissionInheritanceCorrectness(case_, evidence),
    teamConvergence(evidence),
    teamOverBudget(case_, evidence),
    teamPeakConcurrency(evidence),
    // 契约类断言：不占用 §7 的八个指标名额，但同样进了门禁（见 CONTRACT_METRIC_NAMES），
    // 否则数据集中 `expectedMemberStatus` / `expectedResultStatus` / `maxTurns` / `l1`
    // 就只是「被校验但从不生效」的声明——即静默通过通道。
    contractStatuses(case_, evidence),
    contractL1(case_, evidence),
  ];
}
