/**
 * provider 无关的统一入口：按 model.api 分发到具体协议 adapter。
 * 对齐 pi-ai `src/compat.ts` 的 stream()/streamSimple() 分发形态（裁剪：不用 lazy 加载与注册表，
 * 静态分发表只有三个内置协议；不做 env apiKey 注入——apiKey 由调用方经 StreamOptions 传入）。
 */
import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "./types.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";
import * as anthropic from "./providers/anthropic.js";
import * as google from "./providers/google.js";
import * as openai from "./providers/openai.js";

/** api → 协议 adapter 的静态分发表。 */
const PROVIDER_STREAMS: Record<Api, ProviderStreams> = {
	"openai-completions": openai,
	"anthropic-messages": anthropic,
	"google-generative-ai": google,
};

/**
 * 统一 stream 入口。
 * @template TApi 协议类型。
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param options 流式选项。
 * @returns 助手消息事件流。
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	return PROVIDER_STREAMS[model.api].stream(model, context, options);
}

/**
 * 统一 streamSimple 入口（带 thinking 档位的统一选项）。
 * @template TApi 协议类型。
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param options 统一流式选项。
 * @returns 助手消息事件流。
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return PROVIDER_STREAMS[model.api].streamSimple(model, context, options);
}
