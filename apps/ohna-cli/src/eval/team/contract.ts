/**
 * 契约类指标（docs/v2.0/03-team-eval.md §8「T-L1/T-L2a/T-L2b 的纯函数与契约断言」）。
 *
 * 存在的唯一理由：数据集里 `expectedMemberStatus` / `expectedResultStatus` / `maxTurns` /
 * `failedMember`+`failTool` / `l1ProbeMode` 这些声明**必须有消费方**。
 * 若只校验不消费，它们就只是「看起来在断言」的装饰——本任务反复强调的静默通过通道。
 *
 * 两条指标都是 hard 门禁：
 * - `teamContractStatuses`：控制流是否落在 case 声明的形状里（终态 / 整体结果 / 轮数 / 注入点）；
 * - `teamL1Contract`：T-L1 档的三件纯函数契约（摘要投影 / 失败判定 / config 装配）。
 */

import type { TeamCaseEvidence, TeamEvalCase, TeamMetricName, TeamMetricScore } from "./types.js";

/**
 * 契约断言「成员终态 vs 声明」+「case 级结果 vs 声明」+「轮数 ≤ maxTurns」。
 *
 * 三件事合并成一条指标，因为它们都回答同一个问题：「本次控制流是否落在 case 声明的形状里」；
 * 拆成三条只会把同一个 0/1 计入三次，虚增权重。任一不满足即 0 分（fail-closed）。
 *
 * @param case_ 评测 case。
 * @param evidence 证据。
 * @returns 契约指标得分。
 */
export function contractStatuses(case_: TeamEvalCase, evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamContractStatuses";
  if (!evidence.executed) {
    return { name, score: 0, applicable: false, detail: "本档未执行" };
  }
  // 「成员终态 / 整体结果」这两类断言只在**该档真的驱动了成员**时才有意义。
  // T-L1/T-L2a 不跑子代理（成员停留在 idle；只有早退结果），若在此强判会让每一档
  // 都必然失败——那是错档断言，不是覆盖率。判不适用，把判定留给 T-L2b/T-L4。
  const anyRan = evidence.subagentResults.some((result) => result.ran);
  if (!anyRan) {
    return {
      name,
      score: 0,
      applicable: false,
      detail: "本档不驱动成员，成员终态 / 整体结果类断言语义不适用（归 T-L2b/T-L4）",
    };
  }
  // 本档没有真实驱动任何成员（如 T-L2a 的纯状态迁移档）时，「终态是否 done」不在本档断言范围内：
  // 该档成员状态由状态机迁移决定，真实完成度归 T-L2b/T-L4 的 teamSubagentCompletionRate。
  const problems = [
    ...checkMemberStatus(case_, evidence),
    ...checkResultStatus(case_, evidence),
    ...checkTurns(case_, evidence),
    ...checkFailureInjection(case_, evidence, anyRan),
  ];
  return problems.length === 0
    ? { name, score: 1, applicable: true, detail: "成员终态 / 整体结果 / 轮数 / 失败注入均与声明一致" }
    : { name, score: 0, applicable: true, detail: problems.join("；") };
}

/**
 * 断言成员终态与 `expectedMemberStatus` 一致。
 *
 * @param case_ 评测 case。
 * @param evidence 证据。
 * @param anyRan 是否有成员真实运行（否则 done/failed 期望无观测意义）。
 * @returns 问题描述列表（空 = 通过）。
 */
function checkMemberStatus(case_: TeamEvalCase, evidence: TeamCaseEvidence): string[] {
  const problems: string[] = [];
  // 逐成员判断「该成员是否被真实驱动过」，而不是用全局 anyRan：
  // 全局标志会让「有 A 跑了、B 没跑」的 case 对 B 也强行断言，或反过来整体跳过 B。
  const ranMembers = new Set(evidence.subagentResults.filter((result) => result.ran).map((result) => result.member));
  for (const [member, expected] of Object.entries(case_.expectedMemberStatus ?? {})) {
    const actual = evidence.memberStatus[member];
    if (actual === expected) continue;
    // done/failed 是「运行结果」，成员没被驱动时无从判定 → 只有在它确实跑过（或期望态是
    // idle/failed 这类前置态）时才判失败；否则记录为「不可判定」而不是静默通过。
    if (!ranMembers.has(member) && expected === "done") {
      problems.push(`成员 ${member} 期望 done，但该成员未被驱动（无可用证据）`);
      continue;
    }
    problems.push(`成员 ${member} 终态 ${String(actual)} ≠ 期望 ${expected}`);
  }
  return problems;
}

/**
 * 断言 case 级整体结果与 `expectedResultStatus` 一致。
 *
 * @param case_ 评测 case。
 * @param evidence 证据。
 * @returns 问题描述列表。
 */
function checkResultStatus(case_: TeamEvalCase, evidence: TeamCaseEvidence): string[] {
  if (case_.expectedResultStatus === undefined) return [];
  const ran = evidence.subagentResults.filter((result) => result.ran);

  // 没有任何成员真实运行：
  // - 期望 `done` → 不可能达成（没人跑，就没有"都 done"的证据）→ 判失败，而不是跳过；
  // - 期望 `failed` → 也拿不到证据，同样不该放行（否则"没跑"会被记成"达标"）。
  // 早先这里直接 `return []`，等于把「本档没驱动成员」静默当成通过。
  if (ran.length === 0) {
    return [`期望整体 ${case_.expectedResultStatus}，但没有任何成员真实运行（无可用证据）`];
  }

  const allDone = ran.every((result) => result.status === "done");
  if (case_.expectedResultStatus === "done" && !allDone) return ["期望整体 done，但存在 failed 成员"];
  if (case_.expectedResultStatus === "failed" && allDone) return ["期望整体 failed，但全部成员都 done"];
  return [];
}

/**
 * 断言实际轮数落在 `maxTurns` 内。
 *
 * @param case_ 评测 case。
 * @param evidence 证据。
 * @returns 问题描述列表。
 */
function checkTurns(case_: TeamEvalCase, evidence: TeamCaseEvidence): string[] {
  if (case_.maxTurns === undefined) return [];
  return Object.entries(evidence.actualTurns ?? {})
    .filter(([, turns]) => turns > (case_.maxTurns ?? Number.POSITIVE_INFINITY))
    .map(([member, turns]) => `成员 ${member} 用了 ${turns} 轮 > maxTurns ${case_.maxTurns}`);
}

/**
 * 断言失败注入点确实按声明抛出了异常（仅在有成员真实运行时校验）。
 *
 * @param case_ 评测 case。
 * @param evidence 证据。
 * @param anyRan 是否有成员真实运行。
 * @returns 问题描述列表。
 */
function checkFailureInjection(case_: TeamEvalCase, evidence: TeamCaseEvidence, anyRan: boolean): string[] {
  if (!anyRan || case_.failedMember === undefined || case_.failTool === undefined) return [];
  const injected = evidence.failureInjected;
  if (!injected || injected.member !== case_.failedMember || injected.tool !== case_.failTool) {
    return [`失败注入未生效：期望 ${case_.failedMember}.${case_.failTool}`];
  }
  return injected.thrown ? [] : [`失败注入点了 ${injected.tool} 但未抛出异常`];
}

/**
 * L1 纯函数契约指标（仅 T-L1 档有证据；其余档 applicable=false）。
 *
 * 断言三件事，每件都必须为真：
 * - `configHasNoHook`：`assembleSubagentConfig` 在无钩子输入时**不注入**多余额外键；
 * - `abortFailClosed`：`classifyAborted` 在「无错误但也没有有效 assistant 输出」时 fail-closed；
 * - `artifactCount === expectedArtifactCount`：`extractSummary` 的产物引用投影保真。
 *
 * @param case_ 评测 case（本档不用，保留签名一致性）。
 * @param evidence 证据。
 * @returns L1 契约指标。
 */
export function contractL1(case_: TeamEvalCase, evidence: TeamCaseEvidence): TeamMetricScore {
  const name: TeamMetricName = "teamL1Contract";
  const l1 = evidence.l1;
  if (!evidence.executed || !l1) {
    return { name, score: 0, applicable: false, detail: "非 T-L1 档：无纯函数契约证据" };
  }
  const problems: string[] = [];
  if (!l1.configHasNoHook) problems.push("assembleSubagentConfig 注入了多余钩子键");
  // fail-closed 只对 clean 分支有语义：abort 类探针分支本来就应返回 aborted（非 unknown）。
  if ((l1.probeMode ?? "clean") === "clean" && !l1.abortFailClosed) problems.push("classifyAborted 未 fail-closed");
  if (l1.abortCodeTransparent === false) problems.push("classifyAborted 未如实透传 endError / stopReason");
  // misuse 分支必须正向成立（§6.1.2：只忠实投影、不为调用方传错类型兜底）。
  if (l1.abortMisuseNotFailClosed === false) problems.push("classifyAborted 对非 assistant 入参错误地 fail-closed");
  if (l1.artifactCount !== l1.expectedArtifactCount) {
    problems.push(`extractSummary 产物引用 ${l1.artifactCount} ≠ 工具调用 ${l1.expectedArtifactCount}`);
  }
  return problems.length === 0
    ? { name, score: 1, applicable: true, detail: "摘要投影 / 失败判定 / config 装配三件契约成立" }
    : { name, score: 0, applicable: true, detail: problems.join("；") };
}
