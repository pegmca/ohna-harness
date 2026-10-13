/**
 * 成本归因（P3 高价值纯函数模块）：把一次 run 的 loop 事件（message_end / tool_execution_end）
 * 投影为按维度（model / tool / provider）拆分的 token 与成本统计。
 *
 * 设计约束：
 * - 纯函数、不依赖网络/IO，可单测；所有数值读取防御式（非有限 → 0，缺失 usage 跳过该输入）；
 * - 不破坏既有 7 项确定性指标口径，仅作为报告里的附加成本洞察；
 * - 事件视角类型用 LoopEvalRunEvent（与 loop-runner 同形状），消费侧按 type 收窄并防御式读 payload。
 */
import type { AssistantMessage } from "@aiagent/ai";
import type { LoopEvalRunEvent } from "./loop-projection.js";

/** 成本归因维度：按模型 / 工具 / 提供方拆分。 */
export type CostDimension = "model" | "tool" | "provider";

/** 单条归因记录：某一维度下某个 key 的聚合结果。 */
export interface CostAttributionRecord {
  /** 归因维度（model / tool / provider）。 */
  dimension: CostDimension;
  /** 维度键：model 维度为模型名，tool 维度为工具名，provider 维度为提供方名。 */
  key: string;
  /** 输入 token 合计。 */
  inputTokens: number;
  /** 输出 token 合计。 */
  outputTokens: number;
  /** 合计 token。 */
  totalTokens: number;
  /** 成本合计（货币单位由调用方约定，通常为 USD）。 */
  cost: number;
  /** 该 key 下的调用次数（message 或 tool 事件数）。 */
  callCount: number;
}

/** 单次事件视角的成本输入（提取自 LoopEvalRunEvent 的一条事件）。 */
export interface CostAttributionInput {
  /** 来源：message 来自 message_end；tool 来自 tool_execution_end。 */
  source: "message" | "tool";
  /** 维度键：message 为 model；tool 为 toolName。 */
  key: string;
  /** 模型名（message 事件携带）。 */
  model?: string;
  /** 提供方（message 事件携带）。 */
  provider?: string;
  /** 工具名（tool 事件携带）。 */
  toolName?: string;
  /** 用量快照（防御式读取，字段均可缺）。 */
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
}

/**
 * 防御式转数字：非有限数字（NaN / Infinity / 非 number）一律回退为 0，避免脏数据污染聚合。
 *
 * @param value 原始值。
 * @returns 有限数字或 0。
 */
function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 从事件序列提取成本输入：遍历事件、按类型防御式读取用量与维度键，缺失 usage 的输入直接跳过（不报错）。
 *
 * - message_end：从 payload.message（AssistantMessage）读 usage / model / provider；
 * - tool_execution_end：从 payload 读 toolName，并尝试 result.usage 或 result.details.usage（真实工具可能带用量）。
 *
 * @param events run 的事件序列（LoopEvalRunEvent）。
 * @returns 成本输入数组（无 usage 的事件不产生输入）。
 */
export function extractCostInputs(events: readonly LoopEvalRunEvent[]): CostAttributionInput[] {
  const inputs: CostAttributionInput[] = [];

  for (const event of events) {
    if (event.type === "message_end") {
      // message_end payload 形如 { message: AssistantMessage }；防御式读取。
      const message = (event.payload as { message?: AssistantMessage }).message;
      if (!message || !message.usage) continue;
      inputs.push({
        source: "message",
        key: message.model,
        model: message.model,
        provider: message.provider,
        usage: {
          input: toNumber(message.usage.input),
          output: toNumber(message.usage.output),
          totalTokens: toNumber(message.usage.totalTokens),
          cost: { total: toNumber(message.usage.cost?.total) },
        },
      });
    } else if (event.type === "tool_execution_end") {
      // tool_execution_end payload 形如 { toolCallId, toolName, result, isError }；
      // 真实工具可能在 result.usage 或 result.details.usage 带用量，两者皆可选。
      const payload = event.payload as {
        toolName?: string;
        result?: { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }; details?: { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } } };
      };
      const toolName = payload.toolName;
      if (!toolName) continue;
      const usage = payload.result?.usage ?? payload.result?.details?.usage;
      if (!usage) continue;
      inputs.push({
        source: "tool",
        key: toolName,
        toolName,
        usage: {
          input: toNumber(usage.input),
          output: toNumber(usage.output),
          totalTokens: toNumber(usage.totalTokens),
          cost: { total: toNumber(usage.cost?.total) },
        },
      });
    }
  }

  return inputs;
}

/**
 * 按指定维度聚合成本：model → 用 message 的 model 作键；tool → 用 toolName 作键；
 * provider → 用 message 的 provider 作键。结果按 totalTokens 降序，便于报告展示头部贡献方。
 *
 * @param events run 的事件序列。
 * @param dimension 归因维度，默认 "model"。
 * @returns 去重后的归因记录数组（降序）。
 */
export function computeCostAttribution(
  events: readonly LoopEvalRunEvent[],
  dimension: CostDimension = "model"
): CostAttributionRecord[] {
  const inputs = extractCostInputs(events);
  // 按维度筛选有效输入并取维度键：tool 维度只认 tool 事件，model/provider 维度只认 message 事件。
  const bucketKeyOf = (input: CostAttributionInput): string | undefined => {
    if (dimension === "tool") return input.source === "tool" ? input.toolName : undefined;
    if (dimension === "model") return input.source === "message" ? input.model : undefined;
    return input.source === "message" ? input.provider : undefined;
  };

  const buckets = new Map<string, CostAttributionRecord>();
  for (const input of inputs) {
    const key = bucketKeyOf(input);
    if (!key) continue;
    const usage = input.usage ?? {};
    const existing = buckets.get(key);
    if (existing) {
      existing.inputTokens += toNumber(usage.input);
      existing.outputTokens += toNumber(usage.output);
      existing.totalTokens += toNumber(usage.totalTokens);
      existing.cost += toNumber(usage.cost?.total);
      existing.callCount += 1;
    } else {
      buckets.set(key, {
        dimension,
        key,
        inputTokens: toNumber(usage.input),
        outputTokens: toNumber(usage.output),
        totalTokens: toNumber(usage.totalTokens),
        cost: toNumber(usage.cost?.total),
        callCount: 1,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * 便捷汇总：返回整体合计 token / 成本，以及按 model 与按 tool 的两个维度拆分。
 *
 * @param events run 的事件序列。
 * @returns 合计与两个维度的归因记录。
 */
export function summarizeCost(events: readonly LoopEvalRunEvent[]): {
  totalTokens: number;
  totalCost: number;
  byModel: CostAttributionRecord[];
  byTool: CostAttributionRecord[];
} {
  const byModel = computeCostAttribution(events, "model");
  const byTool = computeCostAttribution(events, "tool");
  const totalTokens = byModel.reduce((sum, record) => sum + record.totalTokens, 0)
    + byTool.reduce((sum, record) => sum + record.totalTokens, 0);
  const totalCost = byModel.reduce((sum, record) => sum + record.cost, 0)
    + byTool.reduce((sum, record) => sum + record.cost, 0);
  return { totalTokens, totalCost, byModel, byTool };
}
