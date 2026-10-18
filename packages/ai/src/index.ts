/**
 * @aiagent/ai 公共出口：LLM 抽象层（对齐 pi-ai 的裁剪移植）。
 * 本包不依赖任何本项目其他包，可独立发布。
 */
export * from "./types.js";
export { stream, streamSimple } from "./compat.js";
export {
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
	EventStream,
} from "./utils/event-stream.js";
export { parseJsonWithRepair, parseStreamingJson, partialParse, repairJson } from "./utils/json-parse.js";
export { retryProviderRequest } from "./utils/retry.js";
export { combineAbortSignals, type CombinedAbortSignal } from "./utils/abort-signals.js";
export {
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
	estimateTextTokens,
	type ContextUsageEstimate,
} from "./utils/estimate.js";
export {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "./api/simple-options.js";
export {
	createOpenAiCompatibleRuntime,
	type OpenAiCompatibleOverrides,
	type OpenAiCompatibleRuntimeResult,
} from "./providers/env-runtime.js";
export { resolveActiveModelFromEnv, listAvailableModelProfiles, type ActiveModel } from "./model-selection.js";
export { calculateUsageCost } from "./utils/cost.js";
