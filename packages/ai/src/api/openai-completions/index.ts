/**
 * openai-completions 协议 adapter 入口：stream / streamSimple。
 * 对齐 pi-ai `src/api/openai-completions.ts` 的裁剪版：裸 fetch + 手写 SSE 解析（不依赖 openai SDK），
 * 覆盖 OpenAI/Kimi/DeepSeek 等 OpenAI 兼容服务；差异收敛为 Model.compat 数据而非分支代码。
 *
 * 错误处理契约：请求/运行时失败不抛出，编码为 stopReason "error"/"aborted" 的 error 事件；
 * HTTP 非 2xx 构造带 status/headers 的 ProviderError 形状，交给 retryProviderRequest 判定重试。
 */
import type {
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
} from "../../types.js";
import type { AssistantMessage } from "../../types.js";
import { combineAbortSignals } from "../../utils/abort-signals.js";
import { calculateUsageCost } from "../../utils/cost.js";
import { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { retryProviderRequest } from "../../utils/retry.js";
import { buildBaseOptions, clampReasoning } from "../simple-options.js";
import { buildParams, resolveCompat } from "./request.js";
import { iterateSseChunks } from "./sse.js";
import { StreamingAssembler, stripStreamingScratch } from "./streaming-state.js";

/** openai-completions 特有的流式选项。 */
export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: unknown;
	reasoningEffort?: ThinkingLevel;
}

/** 默认请求超时：10 分钟，对齐 pi / OpenAI SDK 默认值。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 错误消息中响应体的最大保留字符数。 */
const MAX_ERROR_BODY_CHARS = 4000;

/**
 * 检查 headers 中是否已带授权头（此时 apiKey 可为占位值）。
 * @param headers 自定义请求头。
 * @returns 已带授权头返回 true。
 */
function hasAuthorizationHeader(headers: ProviderHeaders | undefined): boolean {
	if (!headers) return false;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === "authorization" && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * 解析 API key：显式 apiKey 优先；已有授权头时用占位值；都没有则抛错（由 stream 编码为 error 事件）。
 * @param provider provider 标识。
 * @param apiKey 显式 apiKey。
 * @param headers 自定义请求头。
 * @returns 可用的 apiKey。
 */
function resolveApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasAuthorizationHeader(headers)) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

/**
 * 合并请求头：默认头 → model.headers → options.headers（后者覆盖前者，null 抑制同名头）。
 * HTTP 头名大小写不敏感，合并按小写归一去重（保留最后一次写入的大小写），
 * 避免 `Authorization` 与 `authorization` 并存导致重复发送。
 * @param model 模型目录条目。
 * @param apiKey 已解析的 apiKey。
 * @param optionsHeaders 调用方自定义头。
 * @returns 最终请求头。
 */
function buildRequestHeaders(
	model: Model<"openai-completions">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	const headers: Record<string, string> = {};
	/** 按小写名归一并保留原键的下标，后者覆盖前者。 */
	const keyByLowerCase = new Map<string, string>();
	const setHeader = (key: string, value: string | null) => {
		const lower = key.toLowerCase();
		const existing = keyByLowerCase.get(lower);
		if (existing !== undefined) {
			delete headers[existing];
		}
		if (value !== null) {
			headers[key] = value;
			keyByLowerCase.set(lower, key);
		} else {
			keyByLowerCase.delete(lower);
		}
	};

	setHeader("content-type", "application/json");
	setHeader("authorization", `Bearer ${apiKey}`);
	for (const [key, value] of Object.entries(model.headers ?? {})) {
		setHeader(key, value);
	}
	for (const [key, value] of Object.entries(optionsHeaders ?? {})) {
		setHeader(key, value);
	}
	return headers;
}

/**
 * 截断错误响应体，避免把超长 body 灌进 errorMessage。
 * @param text 原始文本。
 * @returns 截断后的文本。
 */
function truncateErrorText(text: string): string {
	if (text.length <= MAX_ERROR_BODY_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_BODY_CHARS)}... [truncated ${text.length - MAX_ERROR_BODY_CHARS} chars]`;
}

/**
 * 非 2xx 响应转为带 status/headers 的错误抛出（retryProviderRequest 依赖该形状分类）。
 * @param response fetch 响应。
 */
async function assertOkResponse(response: Response): Promise<void> {
	if (response.ok) return;
	const body = await response.text().catch(() => "");
	const error = new Error(`${response.status}: ${truncateErrorText(body.trim() || response.statusText)}`);
	(error as { status?: number }).status = response.status;
	(error as { headers?: Headers }).headers = response.headers;
	throw error;
}

/**
 * 把裸 fetch 的连接层 rejection（DNS/连接重置/TLS，通常是不带任何 HTTP 信息的 TypeError）
 * 包装成 ProviderError 形状：status/headers 字段存在但为 undefined。
 * retryProviderRequest 据此把 status === undefined 判定为瞬态网络错误并重试（对齐 pi 语义）；
 * 中断路径不受影响——retryProviderRequest 在任何重试前先检查 signal.aborted 并抛 AbortError。
 * @param error fetch rejection 或 assertOkResponse 抛出的 HTTP 错误。
 * @returns 带 ProviderError 形状的错误。
 */
function toProviderError(error: unknown): unknown {
	if (error instanceof Error && "status" in error && "headers" in error) return error;
	const wrapped = error instanceof Error ? error : new Error(String(error));
	(wrapped as { status?: number }).status = undefined;
	(wrapped as { headers?: Headers }).headers = undefined;
	return wrapped;
}

/**
 * 发起一次 chat completions POST。
 * 返回的 cleanup 必须在 body 流消费完毕后调用——过早调用会拆除信号转发监听，
 * 导致流式读取期间调用方的 AbortSignal 无法传播到 fetch。
 * @param model 模型目录条目。
 * @param params 请求体。
 * @param options 流式选项。
 * @returns 2xx 的 fetch Response（body 未消费）与信号清理函数。
 */
async function postChatCompletions(
	model: Model<"openai-completions">,
	params: Record<string, unknown>,
	options?: OpenAICompletionsOptions,
): Promise<{ response: Response; cleanup: () => void }> {
	const fetchFn = options?.fetch ?? globalThis.fetch;
	const apiKey = resolveApiKey(model.provider, options?.apiKey, options?.headers);
	// 超时信号与调用方中断信号合并：任一触发即中断请求。
	const { signal, cleanup } = combineAbortSignals([
		options?.signal,
		AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	]);
	try {
		const response = await fetchFn(`${model.baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildRequestHeaders(model, apiKey, options?.headers),
			body: JSON.stringify(params),
			...(signal ? { signal } : {}),
		});
		await assertOkResponse(response);
		return { response, cleanup };
	} catch (error) {
		cleanup();
		throw toProviderError(error);
	}
}

/**
 * 把捕获的异常格式化为 errorMessage（带 HTTP 状态时前置状态码）。
 * @param error 捕获的异常。
 * @returns 展示用错误消息。
 */
function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

/**
 * 构造初始 pending 状态的 AssistantMessage（全零 usage）。
 * @param model 模型目录条目。
 * @returns 初始 partial 消息。
 */
function createPendingOutput(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/**
 * 流结束后的收尾校验：中断 / error 终态 / 缺 finish_reason 均抛错（由 stream 编码为 error 事件）。
 * @param output 累积完成的消息。
 * @param assembler 流式组装器。
 * @param options 流式选项。
 */
function assertStreamCompleted(
	output: AssistantMessage,
	assembler: StreamingAssembler,
	options: OpenAICompletionsOptions | undefined,
): void {
	if (options?.signal?.aborted || output.stopReason === "aborted") {
		throw new Error("Request was aborted");
	}
	if (output.stopReason === "error") {
		throw new Error(output.errorMessage || "Provider returned an error stop reason");
	}
	if (!assembler.hasFinishReason || output.stopReason === "pending") {
		throw new Error("Stream ended without finish_reason");
	}
}

/**
 * 消费 2xx 响应：onResponse 钩子 → start 事件 → SSE 逐 chunk 组装 → 收尾校验。
 * 信号转发监听在 body 流消费完毕（或出错）后才拆除。
 * @param response fetch 响应。
 * @param cleanup 信号清理函数。
 * @param model 模型目录条目。
 * @param options 流式选项。
 * @param eventStream 事件出口。
 * @param output 累积中的 partial 消息。
 */
async function consumeResponse(
	response: Response,
	cleanup: () => void,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	eventStream: AssistantMessageEventStream,
	output: AssistantMessage,
): Promise<void> {
	try {
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});
		await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);

		eventStream.push({ type: "start", partial: output });
		const assembler = new StreamingAssembler(eventStream, output);
		if (!response.body) {
			throw new Error("Provider response had no body");
		}
		for await (const chunk of iterateSseChunks(response.body)) {
			assembler.applyChunk(chunk, model.id);
		}
		assembler.finishAll();
		assertStreamCompleted(output, assembler, options);
	} finally {
		cleanup();
	}
}

/**
 * openai-completions 流式入口：构造请求 → 重试包裹的 POST → SSE chunk 翻译成事件流。
 * 满足 StreamFunction 契约：失败编码为 error 事件，不抛出。
 */
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	(async () => {
		const output = createPendingOutput(model);

		try {
			const compat = resolveCompat(model);
			let params = buildParams(model, context, options, compat);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as Record<string, unknown>;
			}

			// 裸 fetch 无内置重试，重试统一收在 retryProviderRequest。
			const { response, cleanup } = await retryProviderRequest(() => postChatCompletions(model, params, options), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			});
			await consumeResponse(response, cleanup, model, options, eventStream, output);

			// 成本不是协议字段：把 token 用量按模型目录费率（env 可配）换算成金额，
			// 保证 done 事件携带的 usage.cost 可被 CLI 的会话级 /cost 直接累计。
			output.usage.cost = calculateUsageCost(output.usage, model.cost);

			// consumeResponse 正常返回即保证 stopReason 已收敛为三种成功终态。
			const reason = output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">;
			eventStream.push({ type: "done", reason, message: output });
			eventStream.end();
		} catch (error) {
			stripStreamingScratch(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatErrorMessage(error);
			// 中断/报错前可能已经收到 usage：同样按费率换算，避免 /cost 少记这部分成本。
			output.usage.cost = calculateUsageCost(output.usage, model.cost);
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};

/**
 * streamSimple：合并公共选项（maxTokens 上下文钳制）+ thinking 档位映射后转调 stream。
 * 模型 thinkingLevelMap 把某档位标记为 null（不支持）时按关闭处理。
 */
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clamped = options?.reasoning ? clampReasoning(options.reasoning) : undefined;
	let reasoningEffort: ThinkingLevel | undefined = clamped;
	if (reasoningEffort && model.thinkingLevelMap?.[reasoningEffort] === null) {
		reasoningEffort = undefined;
	}

	return stream(model, context, {
		...base,
		reasoningEffort,
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions);
};
