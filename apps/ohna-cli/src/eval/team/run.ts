/**
 * team 评测的数据集编排与 T-L2a（纯状态迁移）执行器。
 *
 * 职责边界：
 * - `runTeamEval`：按档位分派（T-L1 → run-l1.ts；T-L2a → 本文件；T-L2b/T-L4 → run-provider.ts），
 *   并在无 provider 凭据时产出显式 skip（绝不静默通过）；
 * - `runTeamL2aCase`：只做 TeamState 的纯状态迁移断言，零模型、100% 确定性；
 * - 真 provider 驱动在 `run-provider.ts`（保持本文件聚焦编排与确定性档）。
 */

import { detectProviderCredentials, probeInheritanceGate } from "./adapter.js";
import {
  DEFAULT_POOL,
  buildController,
  emptyEvidence,
  projectBudgetPrecheck,
  projectControllerFacts,
  seedMembers,
} from "./run-support.js";
import { runTeamL1Case } from "./run-l1.js";
import { runTeamProviderCase } from "./run-provider.js";
import { scoreTeamCase } from "./metrics.js";
import type { TeamCaseRun } from "./run-type.js";
import type { TeamCaseEvidence, TeamEvalCase, TeamEvalDataset, TeamTier } from "./types.js";


// `TeamCaseRun` 类型下沉到 run-type.ts（供多个执行器共享，避免循环依赖）。
export type { TeamCaseRun } from "./run-type.js";

/** `runTeamEval` 的选项。 */
export interface RunTeamEvalOptions {
  /** 执行档位。 */
  tier: TeamTier;
  /** 可选凭据覆盖（测试注入；缺省走 `detectProviderCredentials`）。 */
  credentials?: { available: boolean; reason?: string };
  // 说明：曾暴露 `tmpRoot`，但 mock 工具的 execute 不落盘，临时目录只用于构造工具骨架
  // 且随后被删除，外部注入根目录不产生任何可观测差异——属「看似可配置、实则无效」的死参数，
  // 已移除（AGENTS.md：公共接口要小而稳）。
}

// L1 执行器拆在 run-l1.ts（纯函数档，零模型）；此处再导出保持 `run.js` 的公共 API 不变。
export { runTeamL1Case } from "./run-l1.js";

// 共享装配 helper 已下沉到 run-support.ts（打破与 run-provider.ts 的循环依赖）；
// 此处原样再导出，保持 `run.js` 的公共 API 不变。
export {
  DEFAULT_POOL,
  emptyEvidence,
  toEvalModel,
  seedMembers,
  projectControllerFacts,
  buildController,
  projectBudgetPrecheck,
} from "./run-support.js";

/**
 * 执行 T-L2a（纯状态迁移）：`createMember` 的 TeamState 断言 + 「成员不存在」早退路径。
 *
 * `runMember` 只在成员不存在时被调用（早退发生在 `agentLoop` 之前），因此本档零模型、
 * 零 provider 依赖，100% 确定性。
 *
 * @param case_ 评测 case。
 * @returns case 执行结果。
 */
export async function runTeamL2aCase(case_: TeamEvalCase): Promise<TeamCaseRun> {
  const pool = case_.availableTools ?? [...DEFAULT_POOL];
  const maxConcurrent = case_.maxConcurrentMembers ?? 1;
  const denials: string[] = [];
  const toolTrajectory: TeamCaseEvidence["toolTrajectory"] = [];
  const sends: TeamCaseEvidence["sends"] = [];
  const subagentResults: TeamCaseEvidence["subagentResults"] = [];
  const budgetObserved: Array<{ member: string; errorCode?: string; tokens?: number }> = [];
  const hasBudget = case_.maxTokensTotal !== undefined || case_.maxCostPerMember !== undefined;

  // 无 streamFn / 无真实模型：子代理绝不会被真正驱动（本档只断言纯状态迁移）。
  const controller = buildController(case_, [], { denials });
  seedMembers(controller, case_.members ?? [], toolTrajectory);
  seedMembers(controller, case_.expectedSpawns ?? [], toolTrajectory);

  // 派发：已存在的成员在此档**不运行**（不跑模型，故不入 subagentResults——没跑不算失败）；
  // 不存在的成员走 `runMember` 的早退路径（发生在 agentLoop 之前，纯状态、确定性）。
  for (const send of case_.expectedSends ?? []) {
    toolTrajectory.push({ tool: "SendMessage", args: { recipient: send.recipient, content: send.content } });
    sends.push({ recipient: send.recipient, content: send.content });
    const result = await controller.runMember(send.recipient, send.content, undefined, send.estimatedTokens);
    // 预算预检是**纯函数 + 状态判定的早退**（发生在 agentLoop 之前），在本档可确定性地观测：
    // 超限派发会返回 `budget_exceeded` 且成员未被驱动。
    budgetObserved.push({
      member: result.member,
      ...(result.error?.code ? { errorCode: result.error.code } : {}),
      tokens: result.usage?.tokens ?? 0,
    });
    if (!controller.hasMember(send.recipient)) {
      // 早退结果：子代理未启动（ran=false），不计入完成率，由 Dispatch/专项断言判定。
      subagentResults.push({
        member: result.member,
        status: result.status,
        ran: false,
        ...(result.usage ? { usage: result.usage } : {}),
      });
    }
  }

  const evidence: TeamCaseEvidence = {
    ...emptyEvidence(maxConcurrent),
    ...projectControllerFacts(controller, pool, maxConcurrent),
    executed: true,
    spawnedMembers: [...(case_.members ?? []), ...(case_.expectedSpawns ?? [])].map((member) => member.name),
    sends,
    toolTrajectory,
    subagentResults,
    deniedTools: denials,
    memberUsage: Object.fromEntries(subagentResults.map((r) => [r.member, r.usage ?? { tokens: 0, cost: 0 }])),
    // 预算预检在本档是确定性可观测的（纯函数早退，不进 agentLoop）。
    ...(hasBudget
      ? {
          budgetPrecheck: {
            ...projectBudgetPrecheck(
              (case_.expectedSends ?? []).filter((send) => send.estimatedTokens !== undefined).length,
              budgetObserved,
            )!,
            declaredEstimates: (case_.expectedSends ?? [])
              .map((send) => send.estimatedTokens)
              .filter((value): value is number => value !== undefined),
          },
        }
      : {}),
  };

  // 同 L1：本档不跑子代理，故用继承闸门的确定性自证覆盖权限继承通道。
  const firstMember = Object.keys(evidence.grantedToolsByMember)[0];
  const probe = await probeInheritanceGate({
    deniedTools: [
      ...new Set([...(case_.expectedPermission?.deniedTools ?? []), ...(case_.expectedPermissionDenials ?? [])]),
    ],
    grantedTools: firstMember ? (evidence.grantedToolsByMember[firstMember] ?? []) : pool,
  });
  if (probe) evidence.permissionProbe = probe;

  return { id: case_.id, mode: case_.mode, executed: true, evidence, metrics: scoreTeamCase(case_, evidence) };
}
// provider 执行器在 run-provider.ts（保持 run.ts 聚焦数据集编排与 T-L2a）。
export { runTeamProviderCase } from "./run-provider.js";

/**
 * 运行 team 评测数据集（唯一入口）。
 *
 * 档位与执行形态：
 * - `T-L1` / `T-L2a`：确定性，无 provider 依赖，永远执行；
 * - `T-L2b` / `T-L4`：需要真 provider 凭据；无凭据 → 每条 case 产出 `executed:false` +
 *   显式 skip 原因（报告与趋势段都会写明「无 provider 凭据，跳过」，绝不静默通过）。
 *
 * @param dataset 已加载的 team 数据集。
 * @param options tier / 凭据覆盖。
 * @returns 逐 case 执行结果（顺序与数据集一致）。
 */
export async function runTeamEval(dataset: TeamEvalDataset, options: RunTeamEvalOptions): Promise<TeamCaseRun[]> {
  const { tier } = options;
  const runs: TeamCaseRun[] = [];

  if (tier === "T-L1") {
    for (const case_ of dataset.cases) runs.push(await runTeamL1Case(case_));
    return runs;
  }
  if (tier === "T-L2a") {
    for (const case_ of dataset.cases) {
      runs.push(await runTeamL2aCase(case_));
    }
    return runs;
  }

  // T-L2b / T-L4：真 provider 驱动。无凭据时必须显式 skip（§4.2 + 环境无凭据约束）。
  const credentials = options.credentials ?? (await detectProviderCredentials());
  if (!credentials.available) {
    const reason = `无 provider 凭据，跳过 ${tier}（${credentials.reason ?? "未配置真实模型"}）`;
    return dataset.cases.map((case_) => ({
      id: case_.id,
      mode: case_.mode,
      executed: false,
      skipReason: reason,
      evidence: emptyEvidence(case_.maxConcurrentMembers ?? 1),
      metrics: [],
    }));
  }

  const { resolveActiveModelFromEnv } = await import("@aiagent/ai");
  const active = resolveActiveModelFromEnv();
  if (!active) {
    const reason = `provider 凭据解析失败，跳过 ${tier}（resolveActiveModelFromEnv 返回 null）`;
    return dataset.cases.map((case_) => ({
      id: case_.id,
      mode: case_.mode,
      executed: false,
      skipReason: reason,
      evidence: emptyEvidence(case_.maxConcurrentMembers ?? 1),
      metrics: [],
    }));
  }

  // T-L4 与 T-L2b 共享同一条真 provider 执行路径；差异只在「如何用证据」：
  // L2b 只看控制流硬门禁；L4 额外把派发决策指标交给 trend 段（**不阻断**）。
  // 注意：当前**没有** judge 评分链路（见 docs §8.1），L4 是决策观测而非裁判。
  for (const case_ of dataset.cases) {
    runs.push(
      await runTeamProviderCase(case_, {
        model: active.model,
      }),
    );
  }
  return runs;
}
