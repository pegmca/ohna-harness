/**
 * ohna team/Supervisor 编排评测的领域类型（docs/v2.0/03-team-eval.md §5/§7/§8）。
 *
 * 归属：team 评测 case schema 是 ohna 语义（期望成员集、期望派发、期望拒绝、并发上限），
 * 与跨边界线格式 `EvalReportDto` 解耦，**不进** `@aiagent/types`。仅 `EvalReportDto` 等
 * 跨边界 DTO 继续走 `@aiagent/types`（在 metrics / trend 中 `import type` 引用）。
 *
 * 与 coding 评测并列的边界（§8）：
 * - coding 评测 case 在 `../dataset.ts`（`OhnaEvalCase`），team case 在 `./dataset.ts`；
 * - 两套指标名互不重叠（`TeamMetricName` 全带 team 语义），故 team 报告的聚合值不会被
 *   coding 的 `gateReport` 读到，反之亦然（门禁分层的机械保证，不靠人记）。
 *
 * tier 与硬/趋势归属的唯一事实源在本文件 `TEAM_METRIC_SPECS` 表中（§7 指标清单逐条落地），
 * `metrics.ts` / `trend.ts` 只消费该表，不各自维护第二份归属。
 */

/**
 * team 评测档位（§5 的 `T-` 前缀版本）。
 *
 * - `T-L1`：纯函数投影（`@aiagent/agent` 的 `extractSummary` / `classifyAborted` /
 *   `assembleSubagentConfig` / `createBudgetGuard` / `projectTeamCostSummary`）；
 * - `T-L2a`：编排机契约的纯状态迁移（`createMember` / `TeamCreate.execute` /
 *   `SendMessage.execute` 的 TeamState 断言），零模型；
 * - `T-L2b`：真 provider 驱动 + mock 工具副作用，断言只指控制流；
 * - `T-L4`：真模型驱动的编排决策**观测**（趋势门禁，不 block；当前无 judge 评分链路）。
 */
export type TeamTier = "T-L1" | "T-L2a" | "T-L2b" | "T-L4";

/**
 * 门禁归属：团队硬门禁（block）或趋势门禁（不 block）。
 *
 * `trend` 的产出只进 markdown 趋势段与 `trend.json`，**永不参与 exitCode**——
 * 这是 §8「趋势门禁不阻断合并」的机械落点。
 */
export type TeamGateClass = "hard" | "trend";

/** team 指标名（与编码评测的四个指标名零交集，见文件头「门禁分层机械保证」）。 */
export type TeamMetricName =
  | "teamDispatchCorrectness"
  | "teamSubagentCompletionRate"
  | "teamCostAmplificationRatio"
  | "teamTokenAttributionToMember"
  | "teamPermissionInheritanceCorrectness"
  | "teamConvergence"
  | "teamOverBudget"
  | "teamPeakConcurrency"
  // 契约类指标（§8「T-L1/T-L2a/T-L2b 的纯函数与契约断言」的可执行落点）：
  // 它们不占 §7 的八条表单名额，但同样参与硬门禁——否则数据集里
  // expectedMemberStatus / expectedResultStatus / maxTurns / l1 探针就没有任何消费方。
  | "teamContractStatuses"
  | "teamL1Contract";

/**
 * 单指标的静态规约（§7 指标清单的一行）。
 *
 * 每个字段都是「证据源 → tier → 是否可确定性判定 → 门禁归属」的可执行记录：
 * 新增指标必须先在此登记，否则 metrics/trend 不会产出它（防止「默默加指标、默默进门禁」）。
 */
export interface TeamMetricSpec {
  /** 指标名（报告 `metrics[].name`）。 */
  name: TeamMetricName;
  /** 该指标归属的 tier（§7 表第三列）。 */
  tier: TeamTier;
  /** 门禁归属：hard=团队硬门禁；trend=趋势门禁（永不 block）。 */
  gate: TeamGateClass;
  /** 证据源（§7 表「证据源」列，便于定位真相源代码）。 */
  evidenceSource: string;
  /**
   * 是否可确定性判定（不依赖真 provider 的非确定输出）。
   * `false` 的指标在没有 provider 凭据时必须显式 skip，绝不静默按 0/1 记分。
   */
  deterministic: boolean;
  /** 默认值语义说明：不可确定性判定的指标在无证据时的处理方式。 */
  note: string;
}

/**
 * 评测模式（决定该 case 主要覆盖哪类编排语义，与 §8 的六类 case 一一对应）。
 *
 * - `dispatch`：编排成功——建成员 + 派发，终态 done；
 * - `member_not_found`：派发给不存在的成员，走 `runMember` 早退路径；
 * - `over_budget`：团队成本 ceiling 触发护栏，干净停止且累计严格 ≤ ceiling；
 * - `permission_deny`：子代理按继承闸门 + 自身 `allowedTools` 子集被拒；
 * - `concurrency`：多成员扇出，在飞峰值受 `maxConcurrentMembers` 约束；
 * - `failure_isolation`：`runMember` 不可用（执行抛错）时失败隔离为结构化结果。
 */
export type TeamEvalMode =
  | "dispatch"
  | "member_not_found"
  | "over_budget"
  | "permission_deny"
  | "concurrency"
  | "failure_isolation";

/**
 * 期望的成员解析：既可用 `name` 寻址（controller 已预置的成员），也可用 `role` 新建。
 *
 * 成员工具子集语义与 `TeamController.createMember` 一致：
 * - `allowedTools` 缺省 = 从可用池全量授予；
 * - `allowedTools: []` = 显式授予零工具（权限最小化的极端情形，不是「全量」）。
 */
export interface TeamExpectedMember {
  /** 成员名称（消息总线寻址键）。 */
  name: string;
  /** 角色描述（新建成员时必填）。 */
  role?: string;
  /** 被授权工具名子集（缺省全量；空数组=零工具）。 */
  allowedTools?: string[];
}

/**
 * 期望派发：一条 SendMessage 的等价物（recipient + 任务内容）。
 *
 * `estimatedTokens` 用于驱动 `runMember` 的派发前预算估算（§createBudgetGuard 路径），
 * 是「超预算」类别里确定性的预算拒绝证据源（不需要模型参与）。
 */
export interface TeamExpectedSend {
  /** 接收成员名称。 */
  recipient: string;
  /** 委派给该成员的任务正文。 */
  content: string;
  /** 可选派发前预算估算 token 数（触发 `createBudgetGuard` 预检）。 */
  estimatedTokens?: number;
}

/**
 * 期望的权限继承断言。
 *
 * 确定性判定口径（L1 可判，不依赖模型）：成员实际被授予的工具集合必须等于
 * 「可用池 ∩ allowedTools」，且对宣告为 mutate 的成员工具，继承闸门的裁决必须为 deny。
 */
export interface TeamExpectedPermission {
  /** 必须被继承闸门拒绝的工具名（成员侧调用时）。 */
  deniedTools?: string[];
  /** 必须被授予给子代理的工具名（= 可用池 ∩ allowedTools，断言最小化未被破坏）。 */
  grantedTools?: string[];
}

/** 单条 team 评测 case（领域 schema，不进 @aiagent/types）。 */
export interface TeamEvalCase {
  /** case 唯一 id。 */
  id: string;
  /** 给 supervisor / 成员的任务描述（L4 趋势档由真模型消费；确定性档只作日志）。 */
  prompt: string;
  /** 评测模式（决定主覆盖指标，见 `TeamEvalMode`）。 */
  mode: TeamEvalMode;
  /** 可用工具池（所有成员只能是其子集；缺省用评测默认池 `read/write/edit/bash`）。 */
  availableTools?: string[];
  /** 预置成员（controller 预置，不经 TeamCreate）。 */
  members?: TeamExpectedMember[];
  /** 期望通过 TeamCreate 新建的成员（`expectedSpawns` 的显式形状）。 */
  expectedSpawns?: TeamExpectedMember[];
  /** 期望派发序列（recipient/content 对齐 `expectedSends`）。 */
  expectedSends?: TeamExpectedSend[];
  /** 期望的工具调用轨迹（TeamCreate/SendMessage 等编排原语的调用序列）。 */
  expectedToolCalls?: Array<{ tool: string; args?: Record<string, unknown> }>;
  /** 期望的成员终态（成员名 → 状态）。 */
  expectedMemberStatus?: Record<string, "idle" | "running" | "done" | "failed">;
  /** case 级整体预期：所有期望是否应全部满足（用于负例：期望「派发给不存在成员」→ failed）。 */
  expectedResultStatus?: "done" | "failed";
  /** 期望被拒工具（权限继承 deny）。 */
  expectedPermissionDenials?: string[];
  /** 期望权限继承断言（比 `expectedPermissionDenials` 更完整）。 */
  expectedPermission?: TeamExpectedPermission;
  /** 成员并发上限（驱动 `maxConcurrentMembers`）。 */
  maxConcurrentMembers?: number;
  /** 团队成本上限（token），驱动 `maxTokensTotal` 护栏（超预算类别必填）。 */
  maxTokensTotal?: number;
  /** 单成员成本上限（美元），驱动 `maxCostPerMember`。 */
  maxCostPerMember?: number;
  /**
   * 成员执行的模型轮数上限（当前**仅声明 + 契约断言**，尚未在运行期限制）。
   *
   * 实际行为（勿按设计意图误读）：
   * - runner **没有**注入 `shouldStopAfterTurn` 停止钩子去真正截断轮数；
   * - `evidence.actualTurns` 由当前执行路径按「一次派发 = 1 轮」记录，
   *   因此 `teamContractStatuses` 的 `maxTurns` 断言目前只在 >1 时才有区分力；
   * - 要让它成为真正的运行时护栏，需在 T-L2b 执行器中接线 `shouldStopAfterTurn`
   *   并在每轮 turn_end 累加真实轮数（当前未实现）。
   */
  maxTurns?: number;
  /**
   * 失败隔离：在**哪个成员**上让**哪个工具**的执行出口抛错。
   *
   * 精确到「成员 + 工具」而不是「猜池里第一个非 read」——后者在成员的 `allowedTools`
   * 不含该工具时抛错根本不会触发，断言会静默落空（这正是本字段存在的原因）。
   * loader 强制 `failure_isolation` 类别必须声明本字段，且该工具必须真的在
   * `failedMember` 被授予的工具子集内。
   */
  failedMember?: string;
  /** 失败隔离：`failedMember` 上被注入异常的工具名（需同时声明 `failedMember`）。 */
  failTool?: string;
  /**
   * **已废弃且会被 loader 拒绝**的旧字段（仅为兼容解析保留类型）。
   *
   * 旧语义是「在所有成员上让池里第一个非 read 工具抛错」，无法表达「哪个成员/哪个工具」，
   * 猜不中时断言会静默落空。`failure_isolation` 的语义校验现在强制要求
   * `failedMember` + `failTool`，任何仍带本字段的 failure_isolation case 会在加载期报错。
   * 新 case 请直接使用 `failedMember` / `failTool`。
   */
  failSubagentExecution?: boolean;
  /**
   * T-L1 纯函数探针取哪个分支（缺省 `clean`）。
   *
   * 必须随 case 变化，否则探针对任何 case 都返回同一结果、毫无区分力：
   * - `clean`：无 endError、lastAssistant 正常 → `classifyAborted.aborted === false`、
   *   `assembleSubagentConfig` 不注入钩子键；
   * - `end_error`：`endError` 有值 → aborted 且错误码原样透传；
   * - `stop_reason_error`：lastAssistant.stopReason='error' → aborted 且 message 含 stopReason；
   * - `with_hooks`：传入 budgetHook + beforeToolCall → config **必须**带上两个钩子键
   *   （与 `clean` 一起构成「无钩子不注入 / 有钩子必注入」的双向断言）；
   * - `misuse`：调用方误传非 assistant（`{ role: "user", ... }`）→ 契约选择**不是** fail-closed，
   *   即 `aborted === false` 且结果里**没有** `error` 键（§6.1.2「只忠实投影、不承担类型防御」）。
   *   该分支必须正向断言，否则「契约选择为 false」与「探针没跑到」无法区分。
   */
  l1ProbeMode?: "clean" | "end_error" | "stop_reason_error" | "with_hooks" | "misuse";
  /** 可选语义描述（报告可读性与失败回灌）。 */
  expectedOutcome?: string;
}

import type { TeamState } from "@aiagent/agent";

/**
 * `createTeamController` 返回的句柄在评测侧的窄化视图。
 *
 * 只声明评测真正用到的成员（预置 / 派发 / 快照 / 预算累加），
 * 让「评测依赖了 controller 的哪些能力」是一份可读的清单。
 */
export interface TeamControllerHandle {
  /** 是否已存在该成员。 */
  hasMember: (name: string) => boolean;
  /** 创建成员（走生产同一条 `createMember`）。 */
  createMember: (input: { name: string; role: string; tools?: string[] }) => unknown;
  /** 向成员派发任务（第四个参数是派发前预算估算）。 */
  runMember: (
    name: string,
    content: string,
    signal?: AbortSignal,
    estimatedTokens?: number,
  ) => Promise<{
    member: string;
    status: "done" | "failed";
    summary: string;
    usage?: { tokens: number; cost: number };
    error?: { code: string; message: string };
  }>;
  /** 团队状态快照（内存态；用 `@aiagent/agent` 的真实 `TeamState`，不另造一份形状）。 */
  getTeamState: () => TeamState;
  /** 团队预算累加器（只读快照）。 */
  getBudgetAccumulator: () => { totalTokens: number; totalCost: number };
}

/** team 评测数据集（loader 解析产物）。 */
export interface TeamEvalDataset {
  /** schema 版本（如 2.0.0）。 */
  schemaVersion: string;
  /** 数据集版本标识（如 team-v1）。 */
  datasetVersion: string;
  /** 随机种子（可复现性，可选）。 */
  seed?: number;
  /** 数据集领域（默认 ohna）。 */
  domain?: string;
  /** 数据集级最小 case 数（§8 要求 ≥20）。 */
  minCases: number;
  /** 全部 case。 */
  cases: TeamEvalCase[];
}

/**
 * team 单指标得分（内部中间形态，与 coding 的 `MetricScore` 同形但独立类型）。
 *
 * `applicable=false` 表示「本档位 / 本批 case 无该指标的证据」——不参与聚合与门禁
 * （沿用 eval-core 的 G5 语义：`applicable === false` 的指标不进分母）。
 */
export interface TeamMetricScore {
  /** 指标名。 */
  name: TeamMetricName;
  /** 归一化到 [0,1] 的得分（除成本放大比这类非比例指标外）。 */
  score: number;
  /** 是否计入聚合与门禁；缺省 true。 */
  applicable?: boolean;
  /** 本次判定的证据摘要（进报告的可读说明，不参与门禁数值）。 */
  detail?: string;
}

/**
 * 单条 case 的确定性证据（由 run 层从 TeamState / SubagentResult 投影）。
 *
 * 全部字段只来自「内存态 TeamState」「SubagentResult」「团队成员用量」三类真相源，
 * 不含任何模型文本断言——这是「断言只指控制流」的机械保证。
 */
export interface TeamCaseEvidence {
  /** 本 case 是否真正执行（被 skip 的档位为 false，避免假通过）。 */
  executed: boolean;
  /** 成员名 → 终态。 */
  memberStatus: Record<string, "idle" | "running" | "done" | "failed">;
  /** 实际 spawn 的成员集（TeamCreate / 预置成员的并集）。 */
  spawnedMembers: string[];
  /** 实际派发序列（recipient + content）。 */
  sends: Array<{ recipient: string; content: string }>;
  /** 编排原语工具调用轨迹（TeamCreate / SendMessage）。 */
  toolTrajectory: Array<{ tool: string; args?: Record<string, unknown> }>;
  /**
   * SubagentResult 列表（成员名 + 状态 + 用量 + 是否真实运行过）。
   *
   * `ran=false` 表示该结果来自 `runMember` 的**早退**路径（成员不存在 / 派发前预算拒绝），
   * 子代理的 agentLoop 没有启动——这类「预期失败」由专项指标判定，不计入完成率。
   */
  subagentResults: Array<{
    member: string;
    status: "done" | "failed";
    usage?: { tokens: number; cost: number };
    ran?: boolean;
  }>;
  /** 继承闸门实际拒绝的工具名（确定性记录）。 */
  deniedTools: string[];
  /** 每个成员实际被授予的工具子集（可用池 ∩ allowedTools）。 */
  grantedToolsByMember: Record<string, string[]>;
  /** 团队累计用量（`getBudgetAccumulator()` 快照）。 */
  teamUsage: { totalTokens: number; totalCost: number };
  /** 是否观测到预算护栏触发。 */
  budgetExceeded: boolean;
  /** 本次在飞成员峰值（`TeamState.peakConcurrency`）。 */
  peakConcurrency: number;
  /** 并发上限（本 case 装配值）。 */
  maxConcurrentMembers: number;
  /** 每成员累计用量（tokenAttributionToMember 的分子/分母来源）。 */
  memberUsage: Record<string, { tokens: number; cost: number }>;
  /** T-L1 纯函数契约探针结果（仅 L1 档产出；其余档缺省）。 */
  l1?: {
    /** 本次探针取的分支（见 `TeamEvalCase.l1ProbeMode`）。 */
    probeMode?: "clean" | "end_error" | "stop_reason_error" | "with_hooks" | "misuse";
    /** `extractSummary` 投影出的产物引用数。 */
    artifactCount: number;
    /** case 声明的期望工具调用数（产物引用应与之相等）。 */
    expectedArtifactCount: number;
    /** 无 assistant 时摘要是否为占位文本「(子代理无文本输出)」。 */
    summaryIsPlaceholder: boolean;
    /** `classifyAborted` 在「无错误无输出」时是否 fail-closed（aborted + message=unknown）。 */
    abortFailClosed: boolean;
    /** `assembleSubagentConfig` 在无钩子输入时是否零多余键。 */
    configHasNoHook: boolean;
    /** `createBudgetGuard` 对该 case 派发估算是否放行。 */
    budgetAllowed: boolean;
    /** endError / stopReason 分支的错误码是否被如实透传（非一律 unknown）。 */
    abortCodeTransparent?: boolean;
    /**
     * `misuse` 分支：误传非 assistant 时是否为「非 fail-closed」（`aborted===false` 且无 `error` 键）。
     * 只在该分支有值——其余分支断言这个会与「该分支本应 aborted」自相矛盾。
     */
    abortMisuseNotFailClosed?: boolean;
    /** 本 case 声明的派发估算（预算纯函数判定用）。 */
    declaredEstimates?: number[];
  };
  /** 摘要回收通道观测：非空 summary 的成员数（只断言「发生了」，不断言内容）。 */
  summaryNonEmpty?: number;
  /** mock 工具被调用的总次数（控制流观测，不断言「该不该调」）。 */
  toolInvocationCount?: number;
  /** 每个成员实际消耗的模型轮数（由注入的停止钩子计数；`maxTurns` 断言的证据源）。 */
  actualTurns?: Record<string, number>;
  /** 失败隔离注入是否真的生效（成员名 + 工具名 + 是否抛出）。`false` 即断言失败。 */
  failureInjected?: { member: string; tool: string; thrown: boolean };
  /**
   * 派发前预算预检的观测结果（`teamOverBudget` 的真实证据源）。
   *
   * 只记「累计用量 ≤ 上限」是没有区分力的：整档没跑时累计恒为 0，任何上限都"通过"。
   * 因此必须记下**预检对每条派发的裁决**，并断言「超限的派发确实被拒绝且未驱动成员」。
   */
  budgetPrecheck?: {
    /** 预检总次数（每条带 estimatedTokens 的派发一次）。 */
    checked: number;
    /** 被预检拒绝的派发数。 */
    rejected: number;
    /** 被拒绝后仍被驱动的成员（>0 即预检失效，硬失败）。 */
    drivenAfterReject: number;
    /** 本 case 声明的派发估算（用于判定「声明已超上限但预检仍放行」）。 */
    declaredEstimates?: number[];
  };
  /**
   * 权限继承的**确定性自证**结果（T-L1/T-L2a 产出，零模型）。
   *
   * 为什么不只看 `deniedTools`：T-L1/T-L2a 根本不跑子代理，模型不会去调 write，
   * 于是「期望被拒的工具」永远不会被真实触发——那不是实现缺陷，而是「本档测的是继承通道
   * 而非真实触发」（真实触发归 T-L4）。本档改为**主动证明**：用与成员相同的工具子集
   * 调一次继承闸门，记录它是否确实拒绝。这条自证走的是生产同一条 `beforeToolCall` 通道。
   */
  permissionProbe?: {
    /** 被主动探测的工具名（来自期望拒绝集合）。 */
    tool: string;
    /** 继承闸门是否确实拒绝。 */
    blocked: boolean;
    /** 拒绝原因（闸门返回文本）。 */
    reason?: string;
  };
}
