/**
 * T-L1 执行器：纯函数投影档（docs/v2.0/03-team-eval.md §5 / §6.1）。
 *
 * 零模型、零 provider、零工具执行：只以 case 声明的期望为输入，直接调 `@aiagent/agent`
 * 的四个纯函数，断言它们是否按契约还原输入。这样 L1 的断言就住在数据集里而不是散在测试文件里，
 * 数据集新增一条 case 就多一条确定性回归。
 *
 * 之所以能 100% 确定性：本档不触碰 `agentLoop`，因此没有模型采样、没有并发竞态。
 */

import {
  assembleSubagentConfig,
  classifyAborted,
  createBudgetGuard,
  defaultConvertToLlm,
  extractSummary,
  projectTeamCostSummary,
} from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type { Api } from "@aiagent/ai";
import { probeInheritanceGate } from "./adapter.js";
import { scoreTeamCase } from "./metrics.js";
import type { TeamCaseEvidence, TeamEvalCase } from "./types.js";
import type { TeamCaseRun } from "./run-type.js";


/** L1 探针分支类型（与 `TeamEvalCase.l1ProbeMode` 同值）。 */
type L1ProbeMode = NonNullable<TeamEvalCase["l1ProbeMode"]>;

/**
 * 按分支构造 `classifyAborted` 的入参。
 *
 * @param mode 探针分支。
 * @returns `classifyAborted` 入参。
 */
function abortInputFor(mode: L1ProbeMode): Parameters<typeof classifyAborted>[0] {
  if (mode === "end_error") {
    return { endError: { code: "agent_loop_aborted", message: "探针注入的 loop 兜底错误" }, lastAssistant: undefined };
  }
  if (mode === "stop_reason_error") {
    return {
      endError: undefined,
      lastAssistant: { role: "assistant", content: [], stopReason: "error", timestamp: 0 } as unknown as Parameters<
        typeof classifyAborted
      >[0]["lastAssistant"],
    };
  }
  if (mode === "misuse") {
    // 调用方误传非 assistant（这里刻意用 user）：`classifyAborted` 的契约是「只忠实投影停止信号，
    // 不承担类型防御」，因此应当返回 aborted:false 且不带 error——**不是** fail-closed。
    // 类型上 `lastAssistant` 要求 assistant，这里正是要构造「违约入参」，故显式 as unknown。
    return {
      endError: undefined,
      lastAssistant: { role: "user", content: [], timestamp: 0 } as unknown as Parameters<
        typeof classifyAborted
      >[0]["lastAssistant"],
    };
  }
  return { endError: undefined, lastAssistant: undefined };
}

/**
 * 按分支构造 `assembleSubagentConfig` 的入参（`with_hooks` 才注入钩子）。
 *
 * @param mode 探针分支。
 * @param case_ 评测 case（取首个成员名）。
 * @returns `assembleSubagentConfig` 入参。
 */
function configInputFor(mode: L1ProbeMode, case_: TeamEvalCase): Parameters<typeof assembleSubagentConfig>[0] {
  const withHooks = mode === "with_hooks";
  return {
    member: {
      name: case_.members?.[0]?.name ?? "l1-probe",
      role: "l1-probe",
      model: { id: "l1" } as Model<Api>,
      status: "idle",
    },
    budgetHook: withHooks
      ? ({ shouldStopAfterTurn: () => false, addUsage: () => {} } as unknown as Parameters<
          typeof assembleSubagentConfig
        >[0]["budgetHook"])
      : undefined,
    beforeToolCall: withHooks ? async () => undefined : undefined,
    convertToLlm: defaultConvertToLlm,
  };
}

/**
 * 判定 abort 分支的错误码是否被如实透传。
 *
 * @param mode 探针分支。
 * @param probe `classifyAborted` 结果。
 * @returns 是否透明（clean 分支恒 true，该分支不产生错误码）。
 */
function abortCodeTransparent(mode: L1ProbeMode, probe: ReturnType<typeof classifyAborted>): boolean {
  if (mode === "end_error") return probe.error?.code === "agent_loop_aborted";
  if (mode === "stop_reason_error") return probe.aborted && (probe.error?.message ?? "").includes("error");
  if (mode === "misuse") return abortMisuseNotFailClosed(probe);
  return true;
}

/**
 * 判定「误传非 assistant」时是否落在契约声明的非 fail-closed 一侧（§6.1.2）。
 *
 * 必须**正向**判定两项：`aborted === false` 且结果对象里没有 `error` 键。
 * 只检查「没抛错」不足以区分「契约选择为非 fail-closed」与「探针压根没跑」。
 *
 * @param probe `classifyAborted` 结果。
 * @returns 是否为契约声明的非 fail-closed 形态。
 */
function abortMisuseNotFailClosed(probe: ReturnType<typeof classifyAborted>): boolean {
  return probe.aborted === false && !("error" in probe);
}

/**
 * 判定 config 装配契约是否成立：`with_hooks` 必须注入两个钩子键，其余分支不得注入。
 *
 * @param mode 探针分支。
 * @param config 装配产物。
 * @returns 契约是否成立。
 */
function configContractHolds(mode: L1ProbeMode, config: Record<string, unknown>): boolean {
  const hasBoth = "beforeToolCall" in config && "shouldStopAfterTurn" in config;
  const hasNone = !("beforeToolCall" in config) && !("shouldStopAfterTurn" in config);
  return mode === "with_hooks" ? hasBoth : hasNone;
}

/** L1 档的默认可用工具池（与 adapter 的 `DEFAULT_TEAM_TOOL_POOL` 一致）。 */
const DEFAULT_POOL = ["read", "write", "edit", "bash"] as const;

/**
 * 构造 L1 档的空证据骨架。
 *
 * @param maxConcurrentMembers 本 case 的并发上限。
 * @returns 已标记 `executed:true` 的零值证据。
 */
function l1Evidence(maxConcurrentMembers: number): TeamCaseEvidence {
  return {
    executed: true,
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
 * 执行 T-L1（纯函数投影）：不跑模型，直接以 case 声明的期望为输入断言三件 L1 契约。
 *
 * 断言落点（§6.1 的三条）：
 * - `extractSummary`：期望工具调用 → 产物引用数与工具调用数一致（摘要回收投影保真）；
 * - `classifyAborted`：无错误无输出 → `aborted` 且 message 为 `unknown`（fail-closed 兜底）；
 * - `assembleSubagentConfig`：无钩子时**零多余键**（`beforeToolCall` / `shouldStopAfterTurn` 不出现）；
 * - `createBudgetGuard` + `projectTeamCostSummary`：团队上限下的派发判定与成本投影。
 *
 * @param case_ 评测 case。
 * @returns case 执行结果（executed 恒 true，确定性 100%）。
 */
export async function runTeamL1Case(case_: TeamEvalCase): Promise<TeamCaseRun> {
  const toolCalls = case_.expectedToolCalls ?? [];
  const summaryProbe = extractSummary(
    toolCalls.map((step, index) => ({
      role: "toolResult" as const,
      toolCallId: `l1-${index}`,
      toolName: step.tool,
      content: [{ type: "text" as const, text: JSON.stringify(step.args ?? {}) }],
      isError: false,
      timestamp: index,
    })),
  );
  // 探针入参随 case 变化（`l1ProbeMode`），否则对任何 case 都返回同一结果、没有区分力。
  const probeMode = case_.l1ProbeMode ?? "clean";
  const abortProbe = classifyAborted(abortInputFor(probeMode));
  const configProbe = assembleSubagentConfig(configInputFor(probeMode, case_));

  // 预算纯函数：以 case 的团队 token ceiling 判定「该次派发是否应被预检拒绝」。
  const estimatedTokens = case_.expectedSends?.[0]?.estimatedTokens ?? 0;
  const zeroCostModel = { id: "l1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;
  const budgetAllowed =
    case_.maxTokensTotal === undefined && case_.maxCostPerMember === undefined
      ? true
      : createBudgetGuard(
          zeroCostModel,
          estimatedTokens,
          {
            ...(case_.maxTokensTotal !== undefined ? { maxTokensTotal: case_.maxTokensTotal } : {}),
            ...(case_.maxCostPerMember !== undefined ? { maxCostPerMember: case_.maxCostPerMember } : {}),
          },
          { totalTokens: 0, totalCost: 0 },
        );

  // 成本投影：成员用量为空 → 0 成本，但成员数必须与声明一致（投影完整性）。
  const projected = projectTeamCostSummary({
    members: new Map(
      (case_.members ?? []).map((member) => [
        member.name,
        { name: member.name, role: "l1", model: zeroCostModel, status: "done" as const },
      ]),
    ),
    inboundQueues: new Map(),
    events: [],
  });

  const evidence: TeamCaseEvidence = {
    ...l1Evidence(case_.maxConcurrentMembers ?? 1),
    // T-L1 是纯函数档：不驱动任何成员。峰值并发 / 收敛 / 完成率都依赖真实成员执行，
    // 在此档合成数值只会让门禁「看起来覆盖了」——统一置 0 并让指标自身判不适用。
    peakConcurrency: 0,
    subagentResults: [],
    executed: true,
    // L1 不跑成员：预置成员停在 idle（真实完成度归 T-L2b/T-L4）。
    // 只有「预算预检已判超限」时，该次派发对应的成员才标记 failed（护栏拦下的语义），
    // 否则会与 over_budget 类 case 的 `expectedMemberStatus: idle` 自相矛盾。
    memberStatus: Object.fromEntries(
      (case_.members ?? []).map((member) => [
        member.name,
        (budgetAllowed ? "idle" : "failed") as TeamCaseEvidence["memberStatus"][string],
      ]),
    ),
    spawnedMembers: (case_.members ?? []).map((member) => member.name),
    grantedToolsByMember: Object.fromEntries(
      (case_.members ?? []).map((member) => [
        member.name,
        member.allowedTools === undefined
          ? [...(case_.availableTools ?? DEFAULT_POOL)]
          : (case_.availableTools ?? [...DEFAULT_POOL]).filter((tool) => member.allowedTools?.includes(tool)),
      ]),
    ),
    teamUsage: { totalTokens: projected.totalTokens, totalCost: projected.totalCost },
    l1: {
      probeMode,
      artifactCount: summaryProbe.artifacts.length,
      expectedArtifactCount: toolCalls.length,
      summaryIsPlaceholder: summaryProbe.summary === "(子代理无文本输出)",
      // 无错误无输出 → 必须 fail-closed（aborted 且 message 为占位 unknown）。
      abortFailClosed: abortProbe.aborted && abortProbe.error?.message === "unknown",
      // 契约的双向性：clean 模式不得注入钩子键；with_hooks 模式必须注入两个键。
      configHasNoHook: configContractHolds(probeMode, configProbe as unknown as Record<string, unknown>),
      // endError / stopReason 分支的错误必须被如实透传（不是一律 unknown）。
      abortCodeTransparent: abortCodeTransparent(probeMode, abortProbe),
      // misuse 分支：非 assistant 入参应落在「非 fail-closed」一侧，且必须正向断言。
      ...(probeMode === "misuse" ? { abortMisuseNotFailClosed: abortMisuseNotFailClosed(abortProbe) } : {}),
      budgetAllowed,
      declaredEstimates: (case_.expectedSends ?? [])
        .map((send) => send.estimatedTokens)
        .filter((value): value is number => value !== undefined),
    },
  };

  // 权限继承自证：用成员同一工具子集主动探一次闸门（零模型，确定性）。
  const memberTools = evidence.grantedToolsByMember[case_.members?.[0]?.name ?? ""] ?? [...(case_.availableTools ?? DEFAULT_POOL)];
  const probe = await probeInheritanceGate({
    deniedTools: [
      ...new Set([...(case_.expectedPermission?.deniedTools ?? []), ...(case_.expectedPermissionDenials ?? [])]),
    ],
    grantedTools: memberTools,
  });
  if (probe) evidence.permissionProbe = probe;

  return {
    id: case_.id,
    mode: case_.mode,
    executed: true,
    evidence,
    metrics: scoreTeamCase(case_, evidence),
  };
}
