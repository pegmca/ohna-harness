import type { LlmClientConfig } from "@aiagent/types";
import type { TraceRecorder } from "@aiagent/trace";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const KIMI_CODE_OPENAI_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_MODEL = "kimi-for-coding";
export const DEFAULT_PROFILE = "default";

/**
 * 带可选 trace recorder 的 LLM client 配置，createLlmClient 的公开入参类型。
 */
export interface TraceableLlmClientConfig extends LlmClientConfig {
  traceRecorder?: TraceRecorder;
}

/**
 * 归一化后的 LLM client 配置，请求构造逻辑只处理这种完整配置。
 */
export interface NormalizedLlmClientConfig extends TraceableLlmClientConfig {
  timeoutMs: number;
  fetch: typeof fetch;
}

/**
 * 归一化 client 配置，让后续请求构造逻辑只处理完整配置。
 *
 * @param config 调用方传入的原始 client 配置。
 * @returns 带默认超时、默认 fetch 和无尾斜杠 baseUrl 的完整配置。
 */
export function normalizeConfig(config: TraceableLlmClientConfig): NormalizedLlmClientConfig {
  return {
    apiKey: config.apiKey,
    // 只在入口归一化一次，后续拼接供应商路径时不会出现重复斜杠。
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    traceRecorder: config.traceRecorder,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: config.fetch ?? fetch
  };
}
