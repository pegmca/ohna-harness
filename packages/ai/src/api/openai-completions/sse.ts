/**
 * OpenAI chat completions 的 SSE 线格式解析。
 * 对齐 pi-ai `src/api/openai-completions.ts` 中 SDK 隐藏掉的部分：
 * 本项目用裸 fetch（无 openai SDK 依赖），SSE 逐行解析（data: 前缀、[DONE] 终止）。
 */

/** 流式 chunk 中的 tool_call 增量。 */
export interface ChatCompletionChunkToolCall {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/** 流式 chunk 中的 choice delta。 */
export interface ChatCompletionChunkDelta {
	content?: string | null;
	tool_calls?: ChatCompletionChunkToolCall[];
	/** 各兼容端点的推理字段（llama.cpp 用 reasoning_content，其他用 reasoning 等）。 */
	reasoning_content?: string;
	reasoning?: string;
	reasoning_text?: string;
}

/** 流式 usage（stream_options.include_usage 开启后最后一个 chunk 携带）。 */
export interface ChatCompletionChunkUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

/** chat completions 流式 chunk。 */
export interface ChatCompletionChunk {
	id?: string;
	model?: string;
	choices?: Array<{
		delta?: ChatCompletionChunkDelta;
		finish_reason?: string | null;
		/** 部分 provider（如 Moonshot）把 usage 放在 choice 上。 */
		usage?: ChatCompletionChunkUsage;
	}>;
	usage?: ChatCompletionChunkUsage;
}

/**
 * 把 SSE 字节流解析为 chunk 的异步迭代器。
 * 一行可能在网络读取中截断，未完成的行留在 buffer 里等下一段。
 *
 * @param body fetch 响应的可读字节流。
 * @returns 逐个 yield 解析出的 chunk；[DONE] 结束迭代。
 */
export async function* iterateSseChunks(body: ReadableStream<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;

				const data = trimmed.slice("data:".length).trim();
				if (data === "[DONE]") return;

				// 单条坏 chunk 不致命：跳过继续，收尾阶段会以「无 finish_reason」报错。
				try {
					yield JSON.parse(data) as ChatCompletionChunk;
				} catch {
					continue;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
