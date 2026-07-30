/**
 * streamSimple 的公共选项 helper：对齐 pi-ai `src/api/simple-options.ts`。
 * 负责 maxTokens 按上下文窗口钳制、thinking 档位降级与 thinking 预算计算。
 */
import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.js";
import { estimateContextTokens } from "../utils/estimate.js";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

/**
 * 把 maxTokens 钳制进上下文窗口剩余空间（预留 4096 安全 token）。
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param maxTokens 期望的最大输出 token。
 * @returns 钳制后的 maxTokens（至少为 1）。
 */
export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

/**
 * 合并公共流式选项（maxTokens 经上下文钳制）。
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param options streamSimple 入参。
 * @param apiKey 已解析的 API key（优先于 options.apiKey）。
 * @returns 可直接传给协议 adapter 的 StreamOptions。
 */
export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	// 先归一为确定对象，避免逐字段可选链。
	const o: SimpleStreamOptions = options ?? {};
	return {
		temperature: o.temperature,
		maxTokens: clampMaxTokensToContext(model, context, o.maxTokens ?? model.maxTokens),
		signal: o.signal,
		apiKey: apiKey || o.apiKey,
		fetch: o.fetch,
		headers: o.headers,
		onPayload: o.onPayload,
		onResponse: o.onResponse,
		timeoutMs: o.timeoutMs,
		maxRetries: o.maxRetries,
		maxRetryDelayMs: o.maxRetryDelayMs,
	};
}

/**
 * 把 xhigh/max 档位降级为 high（部分 provider 只支持到 high）。
 * @param effort 请求的 thinking 档位。
 * @returns 降级后的档位。
 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * 计算 thinking 开启时的 maxTokens 与 thinking 预算：
 * 默认预算 minimal=1024 / low=2048 / medium=8192 / high=16384；
 * 输出至少保留 1024 token，预算超出时压缩 thinkingBudget。
 *
 * @param baseMaxTokens 调用方显式上限；undefined 表示用模型上限并把 thinking 装进其中。
 * @param modelMaxTokens 模型最大输出 token。
 * @param reasoningLevel thinking 档位。
 * @param customBudgets 自定义档位预算。
 * @returns maxTokens 与 thinkingBudget。
 */
export function adjustMaxTokensForThinking(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
