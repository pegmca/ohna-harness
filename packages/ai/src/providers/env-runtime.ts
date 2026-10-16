/**
 * 从环境变量解析 OpenAI 兼容 provider 的真实 runtime。
 * 这段逻辑从 apps/api 的 composition root 抽出，供 API 与 CLI 共享，
 * 避免两个入口各自重复读取 AIAGENT_LLM_*_<PROFILE> 环境变量并构造 Model。
 * 本文件只依赖 @aiagent/ai 的 Model 类型与 process.env，不引用任何 apps 或 @aiagent/agent，
 * 以免在包层引入循环依赖。
 */

import type { Model } from "../types.js";

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
	const model: Model<"openai-completions"> = {
		id: modelName,
		name: modelName,
		api: "openai-completions",
		provider: profile,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	return { runtime: { model, apiKey } };
}
