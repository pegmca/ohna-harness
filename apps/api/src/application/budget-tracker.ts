/**
 * 运行预算追踪（成本 guardrail）。
 *
 * 背景：run-service 已在线累加 token/成本（cost_summary），但缺运行期预算拦截——
 * 一个失控的 run 可能在被取消前烧掉大量 token/成本。本追踪器在每次用量增量后做预算校验：
 * - 按 run 级（单 run 累计 token/cost 上限）；
 * - 按 user 级（单用户跨 run 累计 token/cost 上限，进程内近似，生产应换 DB 持久账本）。
 * 任一维度超限即返回 overBudget，run-service 据此在下一轮边界停止 run 并标记 budgetExceeded。
 *
 * 进程内 user 累计会在重启后归零（仅作 SLO 护栏近似）；持久化账本是生产 follow-up。
 */

/** 预算上限配置（env 驱动，单位：token 数 / 美元）。 */
export interface BudgetConfig {
  /** 单 run token 上限；缺省不限制。 */
  runMaxTokens?: number;
  /** 单 run 成本上限（美元）；缺省不限制。 */
  runMaxCostUsd?: number;
  /** 单用户 token 上限（进程内近似）；缺省不限制。 */
  userMaxTokens?: number;
  /** 单用户成本上限（美元，进程内近似）；缺省不限制。 */
  userMaxCostUsd?: number;
}

/** 一次用量增量后的预算校验结果。 */
export interface BudgetCheck {
  /** 是否超出任一预算。 */
  overBudget: boolean;
  /** 超限原因（用于 cost_summary 透出）。 */
  reason?: string;
}

/**
 * 运行预算追踪器接口（与实现解耦，便于测试注入 DB 账本）。
 *
 * @param userId 用户标识（user 级累计键）。
 * @param runId Run 标识（run 级累计键）。
 * @param deltaTokens 本次增量 token 数。
 * @param deltaCostUsd 本次增量成本（美元）。
 * @returns 校验结果（超限时 overBudget=true）。
 */
export interface BudgetTracker {
  record(userId: string, runId: string, deltaTokens: number, deltaCostUsd: number): BudgetCheck;
}

/**
 * 创建进程内运行预算追踪器。
 *
 * @param config 预算上限（env 驱动，缺省不限制）。
 * @returns 预算追踪器（进程内累计，重启归零）。
 */
export function createInMemoryBudgetTracker(config: BudgetConfig = {}): BudgetTracker {
  const runTotals = new Map<string, { tokens: number; cost: number }>();
  const userTotals = new Map<string, { tokens: number; cost: number }>();

  function add(map: Map<string, { tokens: number; cost: number }>, key: string, dt: number, dc: number): { tokens: number; cost: number } {
    const prev = map.get(key) ?? { tokens: 0, cost: 0 };
    const next = { tokens: prev.tokens + dt, cost: prev.cost + dc };
    map.set(key, next);
    return next;
  }

  return {
    record(userId, runId, deltaTokens, deltaCostUsd): BudgetCheck {
      const run = add(runTotals, runId, deltaTokens, deltaCostUsd);
      const user = add(userTotals, userId, deltaTokens, deltaCostUsd);
      if (config.runMaxTokens !== undefined && run.tokens > config.runMaxTokens) {
        return { overBudget: true, reason: `run token 超过上限 ${config.runMaxTokens}` };
      }
      if (config.runMaxCostUsd !== undefined && run.cost > config.runMaxCostUsd) {
        return { overBudget: true, reason: `run 成本超过上限 $${config.runMaxCostUsd}` };
      }
      if (config.userMaxTokens !== undefined && user.tokens > config.userMaxTokens) {
        return { overBudget: true, reason: `user token 超过上限 ${config.userMaxTokens}` };
      }
      if (config.userMaxCostUsd !== undefined && user.cost > config.userMaxCostUsd) {
        return { overBudget: true, reason: `user 成本超过上限 $${config.userMaxCostUsd}` };
      }
      return { overBudget: false };
    }
  };
}
