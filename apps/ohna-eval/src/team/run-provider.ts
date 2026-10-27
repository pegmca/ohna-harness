/**
 * T-L2b / T-L4 的真 provider 执行器（从 run.ts 拆出，保持单文件职责单一）。
 *
 * 唯一差异于 T-L2a 的地方：子代理被真实 `streamSimple` 驱动（非 mock、非回放），
 * 因此本文件的一切断言都只指控制流（谁被派发 / 预算是否拦住 / 工具是否被调），
 * 绝不断言模型输出的内容。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@aiagent/ai";
import { streamSimple } from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";
import { createSideEffectMockTools } from "./adapter.js";
import { scoreTeamCase } from "./metrics.js";
import {
  DEFAULT_POOL,
  buildController,
  emptyEvidence,
  projectBudgetPrecheck,
  projectControllerFacts,
  seedMembers,
  toEvalModel,
} from "./run-support.js";
import type { TeamCaseRun } from "./run-type.js";
import type { TeamCaseEvidence, TeamEvalCase } from "./types.js";

/**
 * 执行 T-L2b / T-L4（真 provider 驱动 + mock 工具副作用）。
 *
 * 执行的编排动作（全部走 controller 的公共 API，与生产同一条路径）：
 * 1. 创建成员（权限最小化的工具子集）；
 * 2. 逐条 `runMember` 派发（真 provider 驱动子代理的 agentLoop，并发受信号量约束）；
 * 3. 收尾投影 `TeamState` / 预算累加器 / 逐成员用量 → 证据。
 *
 * 断言面收敛到控制流（§6.3）：status、summary 非空、工具被调用的事实、护栏/并发通道是否触发；
 * **不断言**模型该选哪个工具、该派给谁（那归 T-L4 的真模型 + judge）。
 *
 * @param case_ 评测 case。
 * @param options.model 真 provider 模型。
 * @returns case 执行结果。
 */
export async function runTeamProviderCase(
  case_: TeamEvalCase,
  options: { model: Model<Api> },
): Promise<TeamCaseRun> {
  const pool = case_.availableTools ?? [...DEFAULT_POOL];
  const maxConcurrent = case_.maxConcurrentMembers ?? 1;
  const workspace = mkdtempSync(join(tmpdir(), "ohna-team-eval-"));
  const denials: string[] = [];
  const invocations: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const toolTrajectory: TeamCaseEvidence["toolTrajectory"] = [];
  const sends: TeamCaseEvidence["sends"] = [];
  const subagentResults: TeamCaseEvidence["subagentResults"] = [];
  const memberUsage: TeamCaseEvidence["memberUsage"] = {};
  const summaries: string[] = [];
  const budgetObserved: Array<{ member: string; errorCode?: string; tokens?: number }> = [];
  // 与 buildController 的 budget 装配同条件：只有真的把预算交给 controller，预检才可能发生。
  const hasBudget = case_.maxTokensTotal !== undefined || case_.maxCostPerMember !== undefined;

  try {
    // 失败隔离：由 case 精确声明「在哪个成员上让哪个工具抛错」。
    // 旧写法「猜池里第一个非 read」在成员没被授予该工具时注入根本不触发，
    // 断言会静默落空（loader 已在加载期强制 failedMember + failTool 成对且被授权）。
    const failTool = case_.failTool;
    const failMember = case_.failedMember;
    let injectionThrown = false;
    const tools = await createSideEffectMockTools({
      cwd: workspace,
      pool,
      invocations,
      ...(failTool ? { failTools: [failTool], onFail: () => { injectionThrown = true; } } : {}),
    });
    const controller = buildController(case_, tools, {
      denials,
      model: toEvalModel(options.model),
      // 真实 streamFn：与生产同一条 `streamSimple` 路径（非 mock，非回放）。
      streamFn: streamSimple as StreamFn,
    });

    seedMembers(controller, case_.members ?? [], toolTrajectory);
    seedMembers(controller, case_.expectedSpawns ?? [], toolTrajectory);

    // 逐条派发（与 T-L2a 语义一致）：每个成员拿到**自己那条** content 与 estimatedTokens，
    // 而不是把所有成员喂同一条首条 content。并发仍由 controller 的信号量约束。
    for (const send of case_.expectedSends ?? []) {
      toolTrajectory.push({ tool: "SendMessage", args: { recipient: send.recipient, content: send.content } });
      sends.push({ recipient: send.recipient, content: send.content });
      const result = await controller.runMember(send.recipient, send.content, undefined, send.estimatedTokens);
      subagentResults.push({
        member: result.member,
        status: result.status,
        // 早退（member_not_found / budget_exceeded）不算真实运行；其余失败（工具异常等）算。
        ran: result.error?.code !== "member_not_found" && result.error?.code !== "budget_exceeded",
        ...(result.usage ? { usage: result.usage } : {}),
      });
      // 预检证据的原始观测（推导见 projectBudgetPrecheck）。
      budgetObserved.push({
        member: result.member,
        ...(result.error?.code ? { errorCode: result.error.code } : {}),
        tokens: result.usage?.tokens ?? 0,
      });
      memberUsage[result.member] = result.usage ?? { tokens: 0, cost: 0 };
      summaries.push(result.summary);
    }
    void failMember;

    const facts = projectControllerFacts(controller, pool, maxConcurrent);
    const evidence: TeamCaseEvidence = {
      ...emptyEvidence(maxConcurrent),
      ...facts,
      executed: true,
      memberStatus: facts.memberStatus,
      spawnedMembers: [...(case_.members ?? []), ...(case_.expectedSpawns ?? [])].map((member) => member.name),
      sends,
      toolTrajectory,
      subagentResults,
      deniedTools: denials,
      memberUsage,
      // 控制流观测（不断言内容，只断言「发生了」）。
      summaryNonEmpty: summaries.filter((summary) => summary.length > 0).length,
      toolInvocationCount: invocations.length,
      // 实际轮数：本执行路径按「一次派发 = 一次成员执行」记录，供 maxTurns 契约断言消费。
      actualTurns: Object.fromEntries(subagentResults.map((result) => [result.member, 1])),
      // 派发前预算预检：仅在配置了预算且有估算值时才有观测意义。
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
      ...(failTool && failMember
        ? { failureInjected: { member: failMember, tool: failTool, thrown: injectionThrown } }
        : {}),
    };

    return { id: case_.id, mode: case_.mode, executed: true, evidence, metrics: scoreTeamCase(case_, evidence) };
  } finally {
    // 真实清理临时工作区（mock 工具本来就不落盘，这里保证目录不残留）。
    rmSync(workspace, { recursive: true, force: true });
  }
}
