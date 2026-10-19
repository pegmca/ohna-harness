/**
 * 会话级用量累计与展示：跨 run 维护 token / 成本 / 推理 token，并提供 `/cost` 文案。
 *
 * 为什么从 render.ts 拆出：render 的职责是「AgentEvent → 终端输出」，而用量是会话级
 * 状态（被 harness / repl / web-entry / turn 共同持有），两者生命周期不同。拆开后
 * render.ts 只依赖 `UsageTracker` 的类型接口，不关心累计规则；本模块也不引用任何
 * 渲染原语，保持单向依赖。
 */
import type { Usage } from "@aiagent/ai";

/** 会话累计用量的可持久化快照（与 session-store 的 SessionUsageTotals 同形）。 */
export interface UsageSnapshot {
  /** 累计输入 token。 */
  input: number;
  /** 累计输出 token。 */
  output: number;
  /** 累计 token 总数。 */
  total: number;
  /** 累计成本（美元）。 */
  cost: number;
  /** 累计推理 token（provider 上报时；是 output 的子集）。旧快照可能缺省，按 0 处理。 */
  reasoning?: number;
}

/**
 * 会话级 token / 成本累计器：逐条吸收 assistant 消息的 usage。
 *
 * 与 M1 的「单轮累计」不同，同一实例跨 run 复用，因此 /cost 与 --max-cost 看到的是
 * 整个会话（含 --resume 恢复）的真实累计，而不是最后一轮的局部数字。
 */
export interface UsageTracker {
  /** 累加一条 assistant 消息的用量。 */
  add(usage: Usage): void;
  /** 生成累计小结文案；无任何用量时返回 null（例如被中断的空 run）。 */
  line(): string | null;
  /** 读取当前累计快照（用于 --max-cost 判定与落盘）。 */
  snapshot(): UsageSnapshot;
  /** 从落盘快照恢复（--resume）；覆盖当前累计值。 */
  restore(snapshot: UsageSnapshot): void;
}

/**
 * 创建会话级用量累计器。
 *
 * `reasoning` 是 `output` 的子集，不参与 `total` 计算（provider 已把它算进 output），
 * 只用于 `/cost` 的括注展示，因此单独累计即可。
 *
 * @returns 可累加、快照、恢复的 UsageTracker。
 */
export function createUsageTracker(): UsageTracker {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost = 0;
  let reasoning = 0;

  return {
    add(usage: Usage): void {
      input += usage.input;
      output += usage.output;
      total += usage.totalTokens;
      cost += usage.cost.total;
      reasoning += usage.reasoning ?? 0;
    },
    line(): string | null {
      if (total === 0) return null;
      return `累计 token: ${total}（输入 ${input} / 输出 ${output}），成本 $${cost.toFixed(6)}`;
    },
    snapshot(): UsageSnapshot {
      return { input, output, total, cost, reasoning };
    },
    restore(snapshot: UsageSnapshot): void {
      input = snapshot.input;
      output = snapshot.output;
      total = snapshot.total;
      cost = snapshot.cost;
      reasoning = snapshot.reasoning ?? 0;
    },
  };
}

/**
 * 生成 `/cost` 的展示文案：始终有输出（无用量时明确说明，而不是空行）。
 *
 * 注意：本行数字骨架（累计 token N / 成本 $X）必须保持纯文本，不进 ANSI（§2 红线），
 * 否则 verify 脚本的两个数字捕获组会被转义序列打断。
 *
 * @param tracker 会话级累计器。
 * @returns 单行中文用量文案。
 */
export function formatCostLine(tracker: UsageTracker): string {
  const snapshot = tracker.snapshot();
  if (snapshot.total === 0) {
    return "累计用量：暂无（本会话尚未产生模型调用）";
  }
  // 推理 token 是 output 的子集，存在且 >0 时括注展示（F-3）。
  const reasoning = snapshot.reasoning ?? 0;
  const outputText =
    reasoning > 0 ? `输出 ${snapshot.output}（推理 ${reasoning}）` : `输出 ${snapshot.output}`;
  return `累计用量：token ${snapshot.total}（输入 ${snapshot.input} / ${outputText}），成本 $${snapshot.cost.toFixed(6)}`;
}
