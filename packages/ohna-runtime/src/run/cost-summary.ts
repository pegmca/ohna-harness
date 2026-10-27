/**
 * 托管 run 的 `cost_summary` 能力事件投影（G-T1 收敛，docs/v2.0/03-team-eval.md §9.1）。
 *
 * 边界（为什么落在这里）：
 * - 执行权唯一归属 serve（`RunManager.createRun`），因此 team 成本投影的**唯一生产点**是
 *   serve：run 收尾时这里直接调 `projectTeamCostSummary`。
 * - team 状态来源有两条，**serve 自身首选**：v2.0 起 TeamController 归 serve 的
 *   `run/team-session.ts`（单一 controller、单一成本来源）；组合根仍可经
 *   `RunManagerOptions.getTeamState` 注入（03 G-T1 接通的参数链，保留为 fallback）。
 * - 成员级成本**不在本模块二次累加**：`projectTeamCostSummary` 是唯一真相源，
 *   避免复活 finance-api `run-service.ts` 那种「第二份 team 成本口径」。
 *
 * 「从无到有」的边界：serve 原先**完全不发** `cost_summary`（finance-api 才有内联产线）。
 * 本模块补齐的是这条事件的 serve 侧产线，形状严格对齐 `@aiagent/trace` 的
 * `CostSummaryEvent.payload`（`team` 段与 `members[].durationMs` 在 trace 契约中已是可选字段），
 * 因此属于「按既有契约补生产方」，不是发明新事件。
 */
import {
  projectTeamCostSummary,
  type TeamCostSection,
  type TeamState
} from "@aiagent/agent";
import type { AgentEvent } from "@aiagent/agent";
import type { RunStatusDtoV2 } from "@aiagent/types";
import type { AgentTool } from "@aiagent/tools";
import type { CostSummaryEvent } from "@aiagent/trace";

/** `cost_summary` 事件的线格式负载（= trace `CostSummaryEvent.payload`，可直接序列化）。 */
export type CostSummaryPayload = CostSummaryEvent["payload"];

/** `byModel` / `byTool` 单项聚合桶（trace 契约逐字对齐）。 */
type CostBucket = CostSummaryPayload["byModel"][string];

/**
 * 把任意数值收敛为有限数；非有限（NaN / Infinity / undefined）按 0 处理。
 *
 * 成本是观测性数据：任何脏样本只应贡献 0，绝不能抛异常打断 run 收尾。
 *
 * @param value 候选值。
 * @returns 有限数值或 0。
 */
function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * run 起始时的团队成员用量基线（成员名 → 累计 tokens/cost）。
 *
 * 为什么需要它：`TeamController` 的生命周期是**会话级**（组合根在 CLI 进程里只创建一个实例，
 * `state.members` / `accumulator` 跨 run 存活），而 `cost_summary` 是**run 级**事件。
 * 若直接投影 `getTeamState()` 的全量状态，同一进程第二个 run 的 team 段会把第一个 run 的
 * 成员成本再算一遍，导致成本归因随会话单调虚高（`tokenAttributionToMember` /
 * `costAmplificationRatio` 全部失真）。因此 run 开始时打快照，收尾时只报增量。
 */
export type TeamUsageBaseline = Map<string, { tokens: number; cost: number }>;

/**
 * 为一次 run 打团队用量基线快照（在 run 开始、任何派发之前调用）。
 *
 * @param getTeamState 组合根注入的团队状态读取器；未注入返回 undefined（无需快照）。
 * @returns 成员名 → 当时的累计用量；未注入时 undefined。
 */
export function snapshotTeamBaseline(
  getTeamState: (() => TeamState) | undefined
): TeamUsageBaseline | undefined {
  if (!getTeamState) return undefined;
  try {
    const baseline: TeamUsageBaseline = new Map();
    for (const member of getTeamState().members.values()) {
      baseline.set(member.name, { tokens: member.usage?.tokens ?? 0, cost: member.usage?.cost ?? 0 });
    }
    return baseline;
  } catch {
    // 快照失败绝不能让 run 启动失败：观测数据不得拖垮执行。
    // 退回「无基线」= 收尾时按全量投影（比丢事件更可观测，且与接入前的行为一致）。
    return undefined;
  }
}

/**
 * 把团队状态投影成 `cost_summary.payload.team` 段（G-T1 单一路径）。
 *
 * 与 §9.1.4 对齐的两点语义：
 * 1. `projectTeamCostSummary` 输出**所有**成员（含 0 用量成员），故「创建了但没用模型」的成员会
 *    以 `tokens: 0` 出现在 team 段——这是更完整的可观测性，Web 端 `getTeamView` 已做「0 用量不渲染」。
 * 2. `members[].durationMs` 由投影层在有限数时回填，trace 契约已声明为可选，无需改 DTO。
 *
 * **run 级归因（本函数的核心职责）**：传了 `baseline` 时，投影结果是「本次 run 的增量」——
 * 成员用量取 `当前值 - 基线值`，且本 run 没有任何增量的成员被剔除（它们属于历史 run）。
 * 没传 baseline 时保持「全量投影」语义（供单 run 场景 / 测试直接使用）。
 *
 * @param getTeamState 组合根注入的团队状态读取器（绑定 controller 实例的闭包）；未注入返回 undefined。
 * @param baseline 本 run 开始时的用量快照；传 undefined 表示不按 run 归因。
 * @returns team 段；未注入或没有任何成员时返回 undefined（保持无团队 run 的事件形状不变）。
 */
export function projectRunTeamSection(
  getTeamState: (() => TeamState) | undefined,
  baseline?: TeamUsageBaseline
): TeamCostSection | undefined {
  if (!getTeamState) return undefined;
  const section = projectTeamCostSummary(getTeamState());
  // 未 spawn 任何成员（TeamCreate 从没被调用）时并入空段只会制造误导，故整体省略。
  if (!baseline) return section.members.length > 0 ? section : undefined;

  const members: typeof section.members = [];
  for (const member of section.members) {
    const before = baseline.get(member.name);
    const tokens = member.tokens - (before?.tokens ?? 0);
    const cost = member.cost - (before?.cost ?? 0);
    // 本 run 无增量的成员属于历史 run，不能混进本次 run 的账。
    if (tokens <= 0 && cost <= 0) continue;
    members.push({ ...member, tokens, cost });
  }
  if (members.length === 0) return undefined;
  // 合计必须由**增量成员**重新求和，不能沿用全量段的 totalTokens/totalCost——
  // 否则成员明细是增量、合计却是历史累计，两者自相矛盾（正是跨 run 重复计费的残留形态）。
  const totalTokens = members.reduce((sum, member) => sum + member.tokens, 0);
  const totalCost = members.reduce((sum, member) => sum + member.cost, 0);
  return { ...section, members, totalTokens, totalCost };
}

/**
 * 单次 run 的按维成本聚合器：`turn_end` 累加模型用量，`tool_execution_end` 记录工具调用。
 *
 * 为什么只读 loop 事件：usage 来自 provider 回报（`turn_end.message.usage`），
 * 本类既不估算 token、也不发起额外请求，保证 cost_summary 与 `llm_call` 同源同口径。
 */
export class RunCostAccumulator {
  private readonly byModel = new Map<string, CostBucket>();
  private readonly byTool = new Map<string, CostBucket>();
  private totalTokens = 0;
  private totalCost = 0;
  private turnCount = 0;

  /**
   * 累加一轮 assistant 消息的 usage（`turn_end` 时调用）。
   *
   * @param modelId 产生该消息的模型 id（单模型装配下取本 run 的 model.id）。
   * @param usage provider 回报的 usage；缺失时整条跳过。
   */
  addTurn(modelId: string, usage: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined): void {
    if (!usage) return;
    const input = finiteOrZero(usage.input);
    const output = finiteOrZero(usage.output);
    const totalTokens = finiteOrZero(usage.totalTokens) || input + output;
    const cost = finiteOrZero(usage.cost?.total);
    const bucket = this.byModel.get(modelId) ?? { input: 0, output: 0, totalTokens: 0, cost: 0 };
    bucket.input += input;
    bucket.output += output;
    bucket.totalTokens += totalTokens;
    bucket.cost += cost;
    this.byModel.set(modelId, bucket);
    this.totalTokens += totalTokens;
    this.totalCost += cost;
    this.turnCount += 1;
  }

  /**
   * 记录一次工具执行（`tool_execution_end` 时调用）。
   *
   * byTool 的 token / cost 维度在 serve 侧恒为 0：本项目 usage 是「模型级」回报，
   * 工具本身不产生 token；保留该条目是为了让「哪些工具被调用过」可从 cost_summary 读出，
   * 而不是伪造按工具的 token 归因。
   *
   * @param toolName 工具名。
   */
  addToolExecution(toolName: string): void {
    if (!this.byTool.has(toolName)) {
      this.byTool.set(toolName, { input: 0, output: 0, totalTokens: 0, cost: 0 });
    }
  }

  /**
   * 为本次 run 的每一个已注册工具补齐空桶（保证 byTool 是「工具全集」，未调用为 0）。
   *
   * @param toolNames 本 run 实际注入的工具名列表（按注入顺序）。
   */
  seedTools(toolNames: readonly string[]): void {
    for (const name of toolNames) this.addToolExecution(name);
  }

  /**
   * 投影成 trace 契约的扁平成本字段。
   *
   * @returns 可直接并入 `cost_summary.payload` 的 byModel / byTool / totalTokens / totalCost / turnCount。
   */
  project(): Pick<CostSummaryPayload, "byModel" | "byTool" | "totalTokens" | "totalCost" | "turnCount"> {
    return {
      byModel: Object.fromEntries(this.byModel),
      byTool: Object.fromEntries(this.byTool),
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      turnCount: this.turnCount
    };
  }
}

/**
 * run 级成本追踪器：把「建立聚合 → 逐事件累加 → 收尾投影并发帧」的生命周期收在一处。
 *
 * 为什么是独立对象而不是 `RunManager` 的私有方法：run-manager 已接近单文件行数上限，
 * 而成本这条产线（G-T1）与 run 状态机是正交关注点——把 3 个方法搬进来既腾出行数，
 * 也让「team 成本只有一个投影入口」在文件层面立即可见。
 */
export class RunCostTracker {
  /** runId → 在飞期间的聚合器与起算时间（终态发完事件即删除，避免长进程内存泄漏）。 */
  private readonly runs = new Map<
    string,
    { accumulator: RunCostAccumulator; startedAt: number; conversationId?: string; teamBaseline?: TeamUsageBaseline }
  >();

  /**
   * @param modelId cost_summary 的 byModel 键（单模型装配下即本 run 使用的模型 id）。
   * @param getTeamStateFor 按 conversationId 解析团队状态读取器（spec §7.4：每个会话独立
   *   持有 controller，成本投影必须回到「本 run 所属会话」的当前成员用量，不取全局 last-active）。
   *   未注入时 team 段整体省略。
   */
  constructor(
    private readonly modelId: string,
    private readonly getTeamStateFor: ((conversationId: string) => (() => TeamState) | undefined) | undefined
  ) {}

  /**
   * 建立本次 run 的成本聚合状态（起算时间 + 空聚合器）。
   *
   * 时机要求：必须在 `createRun` 里一建立 `ActiveRun` 就调用，而**不是**在 execute 入口。
   * 因为 `cancel` / `shutdown` 可能在 execute 尚未启动（run 前压缩、workspace 解析期间）
   * 就直接 `finishStatus`；那些 run 也必须拿到 cost_summary，否则「事件缺失」会被误读成
   * 「零成本」。工具表此时未知，byTool 桶由 `seedTools` 在 execute 里补齐。
   *
   * @param runId run id。
   * @param conversationId 本 run 所属会话（team 段投影时按它取 controller，跨会话不串流）。
   */
  begin(runId: string, conversationId?: string): void {
    // team 用量基线必须在此刻（任何派发之前）打快照：controller 是会话级实例，
    // 不收基线就只能在收尾时看到「历史 run + 本 run」的累计值（跨 run 重复计费）。
    const teamBaseline = snapshotTeamBaseline(this.resolveTeamState(conversationId));
    this.runs.set(runId, {
      accumulator: new RunCostAccumulator(),
      startedAt: Date.now(),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(teamBaseline ? { teamBaseline } : {})
    });
  }

  /**
   * 用本 run 实际生效的工具表补齐 byTool 桶（未建立追踪时静默忽略）。
   *
   * 会话级 workspace 可能与实例主工作区不同，故工具表只能在 execute 里确定后再种子化。
   *
   * @param runId run id。
   * @param tools 本 run 实际注入的工具表（未被调用的工具记 0，保证 byTool 是工具全集）。
   */
  seedTools(runId: string, tools: readonly AgentTool[]): void {
    this.runs.get(runId)?.accumulator.seedTools(tools.map((tool) => tool.name));
  }

  /**
   * 按 loop 事件累加成本（只认 turn_end 的 assistant usage 与 tool_execution_end 的调用）。
   *
   * 调用点放在「发帧之前」：即便后续广播失败，聚合数据也已就位（观测数据不依赖 IO 成功）。
   *
   * @param runId run id。
   * @param event loop 事件。
   */
  observe(runId: string, event: AgentEvent): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    if (event.type === "turn_end") {
      if (event.message.role === "assistant") entry.accumulator.addTurn(this.modelId, event.message.usage);
    } else if (event.type === "tool_execution_end") {
      entry.accumulator.addToolExecution(event.toolName);
    }
  }

  /**
   * 投影本次 run 的 `cost_summary.payload`（终态收尾时调用一次；状态随即释放）。
   *
   * 返回 undefined 的唯一原因是「本 run 从未建立追踪」——`begin` 已在 createRun 覆盖所有
   * 可收尾入口，理论上不应出现；一旦出现，调用方**不应**把它当作「零成本」，而是跳过发帧
   * （宁可缺事件，也不发一条会被误读为「成本为 0」的汇总）。
   *
   * @param runId run id。
   * @param status serve 的终态（映射为 trace 的 outcome 枚举）。
   * @param conversationId 本 run 所属会话（终态时若 begin 未留存则按此取 controller）。
   * @returns 待发送的 payload；本 run 未建立追踪时返回 undefined。
   */
  project(runId: string, status: RunStatusDtoV2, conversationId?: string): CostSummaryPayload | undefined {
    const entry = this.runs.get(runId);
    this.runs.delete(runId);
    if (!entry) return undefined;
    // begin 优先，参数兜底：确保终态投影取到「本 run 所属会话」的 controller（§7.4）。
    const resolvedConversationId = entry.conversationId ?? conversationId;
    // 终态映射：serve 的 cancelled 与 interrupted 同为「被中断」，对齐 trace 的 outcome 枚举。
    const outcome = status === "failed" ? "failed" : status === "completed" ? "completed" : "interrupted";
    return buildCostSummaryPayload({
      costs: entry.accumulator.project(),
      team: projectRunTeamSection(this.resolveTeamState(resolvedConversationId), entry.teamBaseline),
      outcome,
      durationMs: Date.now() - entry.startedAt
    });
  }

  /**
   * 按 conversationId 解析团队状态读取器；未注入工厂或该会话无 controller 时返回 undefined。
   *
   * @param conversationId 会话 id（缺省时直接 undefined，team 段省略）。
   * @returns 绑定到该会话 controller 的读取器；不可得时 undefined。
   */
  private resolveTeamState(conversationId?: string): (() => TeamState) | undefined {
    if (!this.getTeamStateFor || conversationId === undefined) return undefined;
    return this.getTeamStateFor(conversationId);
  }
}

/**
 * 组装 `cost_summary` 的终态负载：扁平成本字段 + 可选 team 段 + 终态标记。
 *
 * @param input 聚合器结果、team 段、终态与 run 墙钟耗时。
 * @returns 严格对齐 trace `CostSummaryEvent.payload` 的负载（team 段仅在存在时并入）。
 */
export function buildCostSummaryPayload(input: {
  /** 聚合器投影结果。 */
  costs: ReturnType<RunCostAccumulator["project"]>;
  /** team 段投影结果；undefined 时不并入该键。 */
  team: CostSummaryPayload["team"] | undefined;
  /** run 终态（completed / failed / interrupted）。 */
  outcome: NonNullable<CostSummaryPayload["outcome"]>;
  /** run 端到端墙钟耗时（毫秒）；非有限数时不并入。 */
  durationMs: number | undefined;
}): CostSummaryPayload {
  const { costs, team, outcome, durationMs } = input;
  return {
    byModel: costs.byModel,
    byTool: costs.byTool,
    totalTokens: costs.totalTokens,
    totalCost: costs.totalCost,
    turnCount: costs.turnCount ?? 0,
    outcome,
    ...(team ? { team } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {})
  };
}
