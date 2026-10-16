/**
 * SLO / 容量证据聚合（docs/v1.2 §3 差距#7 收口）。
 *
 * 设计定位：成本数字已由 `cost_summary` 的 byModel/byTool/totalTokens/totalCost 覆盖，
 * 本模块只补「时延 / 成功率 / 并发」三类可量化 SLO 证据，供数据化叙事与看板容量规划。
 *
 * 关键约束：
 * - 本模块是**纯函数聚合层**，不 import trace 包（维持 @aiagent/agent → trace 单向依赖）；
 *   聚合结果由 run-service 在 agent_end 直接并入 cost_summary.payload 的 SLO 段。
 * - 全部数值防御式读取：空数组、非有限值一律按 0 处理，绝不抛异常（观测数据不可因脏样本崩溃）。
 * - 单文件职责单一（<500 行），无运行时依赖、无 IO。
 */

/** 单次 run 的 SLO 原始样本（由 run-service 在 agent_end 采集，或由证据脚本在 mock 下构造）。 */
export interface RunSloSummary {
  /** 本次 run 端到端时延（毫秒）。 */
  durationMs: number;
  /** 本次 run 的 turn 数（assistant 消息数）。 */
  turnCount: number;
  /** run 终态。 */
  outcome: "completed" | "failed" | "interrupted";
  /** 本次 run 总成本（美元），复用 cost_summary 口径。 */
  totalCost: number;
  /** 结束时活跃 run 数（容量快照，可选）。 */
  activeRuns?: number;
  /** 运行期间观测到的活跃 run 峰值（容量证据，可选）。 */
  peakConcurrency?: number;
}

/**
 * 跨多次 run 的 SLO 聚合结果（eval/dashboard 一行指标）。
 * 全部均值/分位在脏样本下定义良好：空数组 → 全 0；非有限值 → 0。
 */
export interface SloAggregate {
  /** 样本数（run 次数）。 */
  count: number;
  /** 成功率 = completed 数 / 总数，取值 [0,1]。 */
  successRate: number;
  /** duration 的 p50 分位（毫秒）。 */
  p50DurationMs: number;
  /** duration 的 p95 分位（毫秒）。 */
  p95DurationMs: number;
  /** duration 算术均值（毫秒）。 */
  avgDurationMs: number;
  /** 成本算术均值（美元）。 */
  avgCost: number;
  /** turn 数算术均值。 */
  avgTurnCount: number;
  /** 跨批观测到的活跃 run 峰值最大值（容量证据；全样本无该值时为 undefined）。 */
  maxActiveRuns?: number;
  /** 跨批观测到的并发峰值最大值（容量证据；全样本无该值时为 undefined）。 */
  maxPeakConcurrency?: number;
}

/**
 * 取升序数组的第 p 分位（nearest-rank 变体：floor(p*(n-1)) 索引）。
 * 纯工具：调用方须确保输入为有限数数组且非空。
 *
 * @param sorted 已升序排列的有限数数组。
 * @param p 分位（0~1），如 0.5=中位、0.95=p95。
 * @returns 分位值。
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * 把多份 RunSloSummary 聚合为 eval/看板可用的一行 SLO 指标。
 * 纯函数：无 IO、无随机、可单测；空数组返回全 0 零值聚合（不抛错）。
 *
 * 口径说明：
 * - successRate = completed 数 / max(count,1)（防御除零）；
 * - p50/p95/avg 先剔除非有限 duration（视为 0），对有限样本升序取分位；
 * - maxActiveRuns / maxPeakConcurrency 仅当存在有限观测值才给出（否则 undefined），
 *   避免把「未采样」误报为 0 容量。
 *
 * @param runs 多次 run 的 SLO 样本（顺序无关）。
 * @returns 聚合结果；空数组返回全 0（maxActiveRuns/maxPeakConcurrency 仍为 undefined）。
 */
export function summarizeSlo(runs: RunSloSummary[]): SloAggregate {
  if (runs.length === 0) {
    return {
      count: 0,
      successRate: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      avgDurationMs: 0,
      avgCost: 0,
      avgTurnCount: 0,
    };
  }

  let completed = 0;
  let durationSum = 0;
  let costSum = 0;
  let turnSum = 0;
  let maxActiveRuns: number | undefined;
  let maxPeakConcurrency: number | undefined;
  const durations: number[] = [];

  for (const run of runs) {
    if (run.outcome === "completed") completed++;
    // 非有限值按 0 处理（观测脏样本不传播异常）。
    const duration = Number.isFinite(run.durationMs) ? run.durationMs : 0;
    const cost = Number.isFinite(run.totalCost) ? run.totalCost : 0;
    const turns = Number.isFinite(run.turnCount) ? run.turnCount : 0;
    durations.push(duration);
    durationSum += duration;
    costSum += cost;
    turnSum += turns;

    // 容量字段仅当为有限数才参与峰值比较，否则视为「未观测」且不污染上限。
    if (Number.isFinite(run.activeRuns)) {
      const v = run.activeRuns as number;
      maxActiveRuns = maxActiveRuns === undefined ? v : Math.max(maxActiveRuns, v);
    }
    if (Number.isFinite(run.peakConcurrency)) {
      const v = run.peakConcurrency as number;
      maxPeakConcurrency = maxPeakConcurrency === undefined ? v : Math.max(maxPeakConcurrency, v);
    }
  }

  durations.sort((a, b) => a - b);
  const count = runs.length;

  return {
    count,
    successRate: completed / Math.max(count, 1),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    avgDurationMs: durationSum / count,
    avgCost: costSum / count,
    avgTurnCount: turnSum / count,
    maxActiveRuns,
    maxPeakConcurrency,
  };
}
