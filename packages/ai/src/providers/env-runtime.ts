/**
 * 从环境变量解析 OpenAI 兼容 provider 的真实 runtime。
 * 这段逻辑从 apps/finance-api 的 composition root 抽出，供 API 与 CLI 共享，
 * 避免两个入口各自重复读取 AIAGENT_LLM_*_<PROFILE> 环境变量并构造 Model。
 * 本文件只依赖 @aiagent/ai 的 Model 类型与 process.env，不引用任何 apps 或 @aiagent/agent，
 * 以免在包层引入循环依赖。
 */

import type { Model } from "../types.js";

/** 上下文窗口缺省值（token）：与 M1 阶段写入的值保持一致，改配置不破坏既有 profile。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 单次响应输出上限缺省值（token）。 */
const DEFAULT_MAX_TOKENS = 8_192;

/** 费率缺省值（美元 / 百万 token）；未配置 cost 时保持历史行为（$0）。 */
const DEFAULT_COST = 0;

/**
 * 读取正整数环境变量；缺失或非法（非整数 / ≤0）时回退缺省值。
 * 非法值不抛错：模型元数据是增强项，不应让一个拼写错误阻断 CLI 启动。
 *
 * @param name 完整环境变量名。
 * @param fallback 缺省值。
 * @returns 合法正整数或回退值。
 */
function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 读取布尔环境变量，接受 true/false/1/0（大小写不敏感）；其它值回退缺省值。
 *
 * @param name 完整环境变量名。
 * @param fallback 缺省值。
 * @returns 解析后的布尔值。
 */
function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return fallback;
}

/**
 * 读取非负数值环境变量（成本允许小数）；缺失或非法（NaN / 负数）时回退缺省值。
 *
 * @param name 完整环境变量名。
 * @param fallback 缺省值。
 * @returns 合法非负数或回退值。
 */
function readNonNegativeNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 调用方显式覆盖值；提供后优先于同名环境变量。 */
export interface OpenAiCompatibleOverrides {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
}

/**
 * 单个 OpenAI 兼容 profile 的解析结果。
 * runtime 与 error 二者必居其一：配置齐全时返回可实例化的 model 与 apiKey，
 * 任一必需项缺失时返回定位到具体环境变量的错误文案。
 */
export type OpenAiCompatibleRuntimeResult = {
	runtime?: { model: Model<"openai-completions">; apiKey: string };
	error?: string;
};

/**
 * 按 profile 从环境变量构造一个 OpenAI 兼容的 Model + apiKey。
 *
 * 读取的变量名规则为：AIAGENT_LLM_API_KEY_<PROFILE>、AIAGENT_LLM_BASE_URL_<PROFILE>、
 * AIAGENT_LLM_MODEL_<PROFILE>（<PROFILE> 大写，如 DEEPSEEK / OPENROUTER / BRIDGE_AI）。
 * overrides 允许调用方显式注入（例如统一 provider-config 下发的真实凭据），
 * 传入后对同名环境变量整体优先。
 *
 * 模型元数据同样可由 env 覆盖（非法值静默回退缺省值，不抛错）：
 * - AIAGENT_LLM_CONTEXT_WINDOW_<PROFILE>：正整数，默认 128000；
 * - AIAGENT_LLM_MAX_TOKENS_<PROFILE>：正整数，默认 8192；
 * - AIAGENT_LLM_REASONING_<PROFILE>：true/false/1/0，默认 false；
 * - AIAGENT_LLM_COST_IN_<PROFILE> / AIAGENT_LLM_COST_OUT_<PROFILE>：美元 / 百万 token，非负数，默认 0。
 *
 * @param profile 模型 profile 稳定标识（deepseek/openrouter/bridge_ai）。
 * @param defaultBaseUrl 缺省 baseUrl（环境变量缺失时使用）。
 * @param overrides 可选的显式覆盖值（apiKey/baseUrl/model）。
 * @returns runtime 与配置错误消息（二者必居其一）。
 */
export function createOpenAiCompatibleRuntime(
	profile: string,
	defaultBaseUrl: string,
	overrides?: OpenAiCompatibleOverrides,
): OpenAiCompatibleRuntimeResult {
	const suffix = profile.toUpperCase();
	const rawApiKey =
		overrides?.apiKey !== undefined
			? overrides.apiKey
			: process.env[`AIAGENT_LLM_API_KEY_${suffix}`];
	// 文档占位符（replace-with-...）按未配置处理：避免把占位 key 当成真实凭据注册成默认模型，
	// 否则会静默用无效 key 请求导致 run 全部 401 失败。
	const apiKey = rawApiKey && !/^replace-with-/i.test(rawApiKey) ? rawApiKey : undefined;
	const baseUrl =
		overrides?.baseUrl !== undefined
			? overrides.baseUrl
			: (process.env[`AIAGENT_LLM_BASE_URL_${suffix}`] || defaultBaseUrl);
	const modelName =
		overrides?.model !== undefined ? overrides.model : process.env[`AIAGENT_LLM_MODEL_${suffix}`];
	if (!apiKey) return { error: `Missing LLM API key for ${profile} (AIAGENT_LLM_API_KEY_${suffix}).` };
	if (!modelName) return { error: `Missing LLM model for ${profile} (AIAGENT_LLM_MODEL_${suffix}).` };
	// 模型元数据（D4）：成本、上下文窗口、输出上限、reasoning 能力都可由 env 覆盖。
	// 缺省值与 M1 完全一致，因此不配置新变量时行为零变化。
	const model: Model<"openai-completions"> = {
		id: modelName,
		name: modelName,
		api: "openai-completions",
		provider: profile,
		baseUrl,
		reasoning: readBooleanEnv(`AIAGENT_LLM_REASONING_${suffix}`, false),
		input: ["text"],
		cost: {
			input: readNonNegativeNumberEnv(`AIAGENT_LLM_COST_IN_${suffix}`, DEFAULT_COST),
			output: readNonNegativeNumberEnv(`AIAGENT_LLM_COST_OUT_${suffix}`, DEFAULT_COST),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: readPositiveIntEnv(`AIAGENT_LLM_CONTEXT_WINDOW_${suffix}`, DEFAULT_CONTEXT_WINDOW),
		maxTokens: readPositiveIntEnv(`AIAGENT_LLM_MAX_TOKENS_${suffix}`, DEFAULT_MAX_TOKENS),
	};
	return { runtime: { model, apiKey } };
}
