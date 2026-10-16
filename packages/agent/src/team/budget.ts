/**
 * 多代理成本护栏（P0）：把「多代理约 15× token、必须成本收口」从设计落成可演示证据。
 *
 * 设计原则（对齐 agent-loop 的扩展哲学：内核零改动）：
 * - 复用 `AgentLoopConfig.shouldStopAfterTurn` 挂载点做「跑中护栏」——每轮 turn_end
 *   的 assistant 消息已带 `usage`（含 `cost.total`），闭包累计并按 per-member / team
 *   上限 + 墙钟 deadline 干净返回 true 停止子代理；不修改 `agent-loop.ts` 一行。
 * - 复用既有 `deadlineMs` 思路做墙钟上限：agent-loop 自身不消费 deadlineMs，故护栏闭包
 *   直接比较时钟，确保子代理不会无限跑（对应「最小并发 + 成本护栏」的 SLO 收口）。
 * - `createBudgetGuard` 是「派发前估算」纯函数：用 `model.cost`（$/百万 token）× 估算
 *   token 数，独立于实际 usage 预先拒绝明显超预算的任务，便于单测。
 */
import type { Api, Model } from "@aiagent/ai";
import type { ShouldStopAfterTurnContext } from "../types.js";
import type { AsyncMutex } from "./concurrency.js";

/** $/百万 token 换算分母（model.cost 单位是每百万 token 美元）。 */
const TOKENS_PER_MILLION = 1_000_000;

/**
 * 成本护栏配置：per-member 上限与团队总 ceiling，以及子代理 run 的墙钟 deadline。
 * 任一阈值被触发即停止子代理（干净 stop，不是崩溃）。
 */
export interface BudgetGuardConfig {
  /** 单成员 token 累计上限；超出后 shouldStopAfterTurn 返回 true。 */
  maxTokensPerMember?: number;
  /** 单成员成本累计上限（美元）；超出后停止。 */
  maxCostPerMember?: number;
  /** 团队总 token 累计上限（跨所有成员累加）。 */
  maxTokensTotal?: number;
  /** 团队总成本累计上限（美元）。 */
  maxCostTotal?: number;
  /** 子代理 run 墙钟上限（毫秒），复用 deadlineMs 思路，避免单成员失控跑飞。 */
  deadlineMs?: number;
}

/**
 * 团队聚合成本累加器：跨成员共享的可变引用，由 controller 持有并传入每个 runMember 的护栏闭包。
 * 每个子代理的 usage 累加入此对象，从而实现「团队总 ceiling」这一跨成员约束。
 */
export interface TeamBudgetAccumulator {
  /** 团队累计 token 数。 */
  totalTokens: number;
  /** 团队累计成本（美元）。 */
  totalCost: number;
}

/**
 * 派发前预算估算（纯函数）：用 `model.cost`（$/百万 token）× 估算 token 数，
 * 预先拒绝明显超预算的任务。独立于实际 usage，便于单测与「派发前就拦住失控任务」。
 *
 * 估算成本采用 worst-case 假设：把全部 token 同时按 input 与 output 费率计入
 * （取两者之和近似上界），避免低估导致放行后真实超支。
 *
 * @param model 成员模型（提供 input/output 费率）。
 * @param estimatedTokens 调用方按任务规模估算的 token 数。
 * @param config 护栏配置（取 per-member / team 成本上限）。
 * @param accumulator 团队聚合累加器（只读，用于判断团队总余量）。
 * @returns true 表示预算允许派发；false 表示会突破上限，应拒绝。
 */
export function createBudgetGuard(
  model: Model<Api>,
  estimatedTokens: number,
  config: BudgetGuardConfig,
  accumulator: TeamBudgetAccumulator,
): boolean {
  const perMillion = model.cost.input + model.cost.output;
  const estimatedCost = (estimatedTokens / TOKENS_PER_MILLION) * perMillion;

  // per-member 成本上限：估算成本本身已超单成员预算。
  if (config.maxCostPerMember !== undefined && estimatedCost > config.maxCostPerMember) {
    return false;
  }
  // 团队总 ceiling：估算成本超出团队剩余余额。
  if (config.maxCostTotal !== undefined) {
    const remaining = config.maxCostTotal - accumulator.totalCost;
    if (estimatedCost > remaining) return false;
  }
  return true;
}

/**
 * 子代理运行时护栏句柄：把「shouldStopAfterTurn 钩子」与「本次子代理累计用量」打包，
 * 便于 controller 把 per-member 用量投影到 TeamMember / SubagentResult，而团队总用量
 * 仍通过共享累加器维护。
 */
export interface MemberBudgetHook {
  /** 注入 `subConfig.shouldStopAfterTurn` 的钩子：触发阈值时返回 true 干净停止（可异步，内部用 mutex 串行化）。 */
  shouldStopAfterTurn: (ctx: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  /** 本次子代理累计用量（token 数 + 成本美元），由钩子在每轮 turn_end 累加。 */
  usage: { tokens: number; cost: number };
}

/**
 * 创建子代理运行时护栏（注入 `subConfig.shouldStopAfterTurn`）。
 *
 * 钩子内累计本次子代理的 `message.usage.totalTokens` 与 `message.usage.cost.total`，
 * 并对 controller 级共享累加器累加；当 per-member 的 `maxCostPerMember` / `maxTokensPerMember`
 * 或团队总 ceiling 或墙钟 deadline 触发时返回 true 干净停止。
 *
 * 原子性（A-1 修复）：整个「读累加器 → 判定 → 提交累加」被 `mutex` 串行化，避免并发成员的
 * 钩子在 await 间隙穿插导致双双放行突破团队 ceiling。采用 **pre-commit 判定**：先算出
 * 「若本回合用量被累计后」的团队总量，超限则直接停止且 *不提交团队累加器*，从而保证任何时刻
 * 团队累计 `totalTokens/totalCost` 都不超过 ceiling（超限那回合的用量只计入该成员的 per-member
 * 用量用于可观测，不污染团队总额）。per-member 用量无论是否停止都提交，确保用量报告准确。
 *
 * 墙钟上限：`deadlineAt` 由 controller 在信号量 `acquire()` 成功之后传入（排队等待期不计墙钟，
 * 见 A-3），护栏闭包直接查时钟收口——agent-loop 本身不消费 deadlineMs。
 *
 * @param model 成员模型（仅用于语义清晰，实际用量取自 message.usage）。
 * @param config 护栏配置。
 * @param accumulator 团队聚合累加器（跨成员共享引用）。
 * @param mutex 团队级互斥锁，把读-判-写临界区串行化（防并发突破 ceiling）。
 * @param deadlineAt 墙钟截止时刻（Unix 毫秒）；缺省则无 deadline。由 controller 在 acquire 后计算传入。
 * @returns 含 shouldStopAfterTurn 钩子与可观测 per-member 用量的句柄。
 */
export function createMemberStopHook(
  model: Model<Api>,
  config: BudgetGuardConfig,
  accumulator: TeamBudgetAccumulator,
  mutex: AsyncMutex,
  deadlineAt?: number,
): MemberBudgetHook {
  const usage: { tokens: number; cost: number } = { tokens: 0, cost: 0 };

  const shouldStopAfterTurn = async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
    // 临界区加锁：读累加器 → 判定 → 提交累加 必须原子，避免并发成员穿插突破团队 ceiling。
    await mutex.acquire();
    try {
      const msgUsage = ctx.message.usage;

      // 先提交 per-member 用量（无论是否被停止都提交，保证用量报告准确）。
      usage.tokens += msgUsage.totalTokens;
      usage.cost += msgUsage.cost.total;

      // 墙钟上限：agent-loop 不消费 deadlineMs，护栏直接查时钟收口。
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) return true;

      // per-member ceiling。
      if (config.maxTokensPerMember !== undefined && usage.tokens >= config.maxTokensPerMember) return true;
      if (config.maxCostPerMember !== undefined && usage.cost >= config.maxCostPerMember) return true;

      // team 总 ceiling：pre-commit 判定——算出本回合累计后的团队总量，
      // 若会突破 ceiling 则直接停止且「不提交团队累加器」，保证团队总额永不超 ceiling；
      // 只有未超时才提交团队累加器，使团队累计 totalTokens/totalCost 严格受 ceiling 约束。
      const projectedTokens = accumulator.totalTokens + msgUsage.totalTokens;
      const projectedCost = accumulator.totalCost + msgUsage.cost.total;
      const teamOver =
        (config.maxTokensTotal !== undefined && projectedTokens >= config.maxTokensTotal) ||
        (config.maxCostTotal !== undefined && projectedCost >= config.maxCostTotal);

      if (!teamOver) {
        accumulator.totalTokens += msgUsage.totalTokens;
        accumulator.totalCost += msgUsage.cost.total;
      }

      return teamOver;
    } finally {
      // 释放锁，唤醒下一个等待的并发成员钩子；必须在 finally 中保证不挂死。
      mutex.release();
    }
  };

  return { shouldStopAfterTurn, usage };
}
