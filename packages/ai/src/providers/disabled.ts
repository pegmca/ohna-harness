/**
 * 未启用协议的 provider 类型桩工厂。
 * 阶段 1 只落地 openai-completions 协议；anthropic / google 仅保留与 ProviderStreams
 * 形状一致的 stream/streamSimple，调用即产生结构化 error 事件（不实现协议）。
 */
import type { AssistantMessage, Context, Model, ProviderStreams } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

/**
 * 构造一个「尚未启用」的 provider 桩。
 * @param api 协议标识。
 * @returns 满足 ProviderStreams 形状的 stream/streamSimple；调用立即产出 error 事件流。
 */
export function createDisabledProviderStreams(api: "anthropic-messages" | "google-generative-ai"): ProviderStreams {
	const createStream = (model: Model<never>, _context: Context): AssistantMessageEventStream => {
		const typedModel = model as Model<typeof api>;
		const eventStream = new AssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api,
			provider: typedModel.provider,
			model: typedModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: `api "${api}" 尚未启用：阶段 1 只落地 openai-completions 协议`,
			timestamp: Date.now(),
		};
		eventStream.push({ type: "start", partial: output });
		eventStream.push({ type: "error", reason: "error", error: output });
		eventStream.end();
		return eventStream;
	};

	return {
		stream: (model, context) => createStream(model as Model<never>, context),
		streamSimple: (model, context) => createStream(model as Model<never>, context),
	};
}
