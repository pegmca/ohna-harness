/**
 * 用量成本计算：把 token 数与模型目录费率换算成美元金额。
 *
 * 为什么单独成模块：成本不是 provider 协议的一部分，而是「模型元数据 × usage」的纯函数。
 * provider 只负责产出 token 数，收尾时统一调用本函数写入 usage.cost，避免每个协议
 * adapter 各写一份换算（也避免费率单位在不同 adapter 里漂移）。
 */
import type { ModelCost, Usage } from "../types.js";

/** 费率单位：模型目录的 cost 为「美元 / 百万 token」。 */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * 按模型费率计算一条 usage 的金额明细。
 *
 * @param usage 已归一化的 token 用量（只读取 token 字段）。
 * @param cost 模型目录费率（美元 / 百万 token）。
 * @returns 与 usage 同形状的成本明细，total 为四项之和。
 */
export function calculateUsageCost(
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">,
	cost: ModelCost,
): Usage["cost"] {
	const input = (usage.input * cost.input) / TOKENS_PER_PRICE_UNIT;
	const output = (usage.output * cost.output) / TOKENS_PER_PRICE_UNIT;
	const cacheRead = (usage.cacheRead * cost.cacheRead) / TOKENS_PER_PRICE_UNIT;
	const cacheWrite = (usage.cacheWrite * cost.cacheWrite) / TOKENS_PER_PRICE_UNIT;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
