/**
 * OpenAI 兼容 provider 入口：分发到 openai-completions 协议 adapter。
 * 对齐 pi-ai 的 ProviderStreams 分发形态；同一协议覆盖 OpenAI/Kimi/DeepSeek 等服务。
 */
import type { Context, Model, SimpleStreamOptions, StreamOptions } from "../types.js";
import {
	stream as openAICompletionsStream,
	streamSimple as openAICompletionsStreamSimple,
	type OpenAICompletionsOptions,
} from "../api/openai-completions/index.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";

/**
 * 校验 model.api 与本 provider 匹配（不匹配属编程错误，直接抛出）。
 * @param model 模型目录条目。
 */
function assertApi(model: Model<"openai-completions">): void {
	if (model.api !== "openai-completions") {
		throw new Error(`Mismatched api: ${model.api}, expected openai-completions`);
	}
}

/**
 * OpenAI 兼容链路的 stream 入口。
 * @param model 模型目录条目（api 必须为 "openai-completions"）。
 * @param context 请求上下文。
 * @param options 流式选项。
 * @returns 助手消息事件流。
 */
export function stream(
	model: Model<"openai-completions">,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	assertApi(model);
	return openAICompletionsStream(model, context, options as OpenAICompletionsOptions | undefined);
}

/**
 * OpenAI 兼容链路的 streamSimple 入口（带 thinking 档位的统一选项）。
 * @param model 模型目录条目（api 必须为 "openai-completions"）。
 * @param context 请求上下文。
 * @param options 统一流式选项。
 * @returns 助手消息事件流。
 */
export function streamSimple(
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	assertApi(model);
	return openAICompletionsStreamSimple(model, context, options);
}
