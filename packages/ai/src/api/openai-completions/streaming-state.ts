/**
 * 流式增量组装器：把 chat completions chunk 翻译成 AssistantMessageEvent。
 * 对齐 pi-ai `src/api/openai-completions.ts` stream() 内联的块跟踪逻辑，
 * 抽成独立类以控制单函数规模。裁剪：去掉 custom/grammar tools 与加密 reasoning_details。
 */
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../../types.js";
import type { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { parseStreamingJson } from "../../utils/json-parse.js";
import { mapStopReason, parseChunkUsage } from "./request.js";
import type { ChatCompletionChunk, ChatCompletionChunkDelta, ChatCompletionChunkToolCall } from "./sse.js";

/** 流式中的 toolCall 块：partialArgs 是拼接中的原始 JSON 文本，收尾时解析并删除。 */
interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}

type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;

/**
 * 按 chunk 增量维护 output.content 并推送事件。
 * 每个事件都携带当前累积的完整 partial message，消费者无需自行拼装。
 */
export class StreamingAssembler {
	private textBlock: TextContent | null = null;
	private thinkingBlock: ThinkingContent | null = null;
	private readonly toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
	private readonly toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
	/** 最近一个 toolCall 块：无 index/id 的续传增量回退到它（见 findToolCallBlock）。 */
	private lastToolCallBlock: StreamingToolCallBlock | null = null;
	private readonly blocks: StreamingBlock[];
	/** 是否见过 finish_reason（流正常收尾的判据）。 */
	hasFinishReason = false;

	/**
	 * @param stream 事件出口。
	 * @param output 累积中的 partial AssistantMessage（content 就地追加）。
	 */
	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly output: AssistantMessage,
	) {
		this.blocks = output.content as StreamingBlock[];
	}

	/**
	 * 内容块在 output.content 中的下标。
	 * @param block 内容块。
	 * @returns 下标；不存在返回 -1。
	 */
	private getContentIndex(block: StreamingBlock): number {
		return this.blocks.indexOf(block);
	}

	/**
	 * 处理一个 chunk：usage / responseId / 文本 / 推理 / tool_call / finish_reason。
	 * @param chunk 解析后的流式 chunk。
	 * @param requestedModelId 请求的模型 id（用于识别上游改写后的实际模型）。
	 */
	applyChunk(chunk: ChatCompletionChunk, requestedModelId: string): void {
		if (!chunk || typeof chunk !== "object") return;
		this.applyChunkMeta(chunk, requestedModelId);

		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		if (!choice) return;

		// 兜底：部分 provider（如 Moonshot）把 usage 放在 choice 上。
		if (!chunk.usage && choice.usage) {
			this.output.usage = parseChunkUsage(choice.usage);
		}
		this.applyFinishReason(choice.finish_reason);

		const delta = choice.delta;
		if (!delta) return;

		if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
			const block = this.ensureTextBlock();
			block.text += delta.content;
			this.stream.push({ type: "text_delta", contentIndex: this.getContentIndex(block), delta: delta.content, partial: this.output });
		}

		this.applyReasoningDelta(delta);
		this.applyToolCallDeltas(delta.tool_calls);
	}

	/**
	 * 处理一组 tool_call 增量。
	 * @param toolCalls chunk 中的 tool_calls 数组。
	 */
	private applyToolCallDeltas(toolCalls: ChatCompletionChunkToolCall[] | undefined): void {
		if (!toolCalls) return;
		for (const toolCall of toolCalls) {
			this.applyToolCallDelta(toolCall);
		}
	}

	/**
	 * 处理 chunk 级元数据：responseId / responseModel / usage。
	 * @param chunk 解析后的流式 chunk。
	 * @param requestedModelId 请求的模型 id（用于识别上游改写后的实际模型）。
	 */
	private applyChunkMeta(chunk: ChatCompletionChunk, requestedModelId: string): void {
		// 同一流的所有 chunk 携带相同 id。
		this.output.responseId ||= chunk.id;
		if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== requestedModelId) {
			this.output.responseModel ||= chunk.model;
		}
		if (chunk.usage) {
			this.output.usage = parseChunkUsage(chunk.usage);
		}
	}

	/**
	 * 处理 finish_reason：映射 stopReason 并标记流正常收尾。
	 * @param finishReason chunk 的 finish_reason。
	 */
	private applyFinishReason(finishReason: string | null | undefined): void {
		if (!finishReason) return;
		const finishReasonResult = mapStopReason(finishReason);
		this.output.stopReason = finishReasonResult.stopReason;
		if (finishReasonResult.errorMessage) {
			this.output.errorMessage = finishReasonResult.errorMessage;
		}
		this.hasFinishReason = true;
	}

	/**
	 * 处理推理字段增量：取第一个非空的 reasoning_content / reasoning / reasoning_text，
	 * 字段名存为 thinkingSignature 供历史回放。
	 * @param delta chunk 的 choice delta。
	 */
	private applyReasoningDelta(delta: ChatCompletionChunkDelta): void {
		const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
		for (const field of reasoningFields) {
			const value = delta[field];
			if (typeof value === "string" && value.length > 0) {
				const block = this.ensureThinkingBlock(field);
				block.thinking += value;
				this.stream.push({ type: "thinking_delta", contentIndex: this.getContentIndex(block), delta: value, partial: this.output });
				return;
			}
		}
	}

	/**
	 * 处理单个 tool_call 增量：按 index（缺省按 id）归块，拼接参数 JSON。
	 * @param toolCall chunk 中的 tool_call 增量。
	 */
	private applyToolCallDelta(toolCall: ChatCompletionChunkToolCall): void {
		const block = this.ensureToolCallBlock(toolCall);
		if (!block.id && toolCall.id) {
			block.id = toolCall.id;
			this.toolCallBlocksById.set(toolCall.id, block);
		}
		const name = toolCall.function?.name;
		if (!block.name && name) {
			block.name = name;
		}

		let delta = "";
		if (toolCall.function?.arguments) {
			delta = toolCall.function.arguments;
			block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
			block.arguments = parseStreamingJson(block.partialArgs);
		}
		this.stream.push({ type: "toolcall_delta", contentIndex: this.getContentIndex(block), delta, partial: this.output });
	}

	/**
	 * 取当前文本块，不存在则创建并推 text_start。
	 * @returns 当前文本块。
	 */
	private ensureTextBlock(): TextContent {
		if (!this.textBlock) {
			this.textBlock = { type: "text", text: "" };
			this.blocks.push(this.textBlock);
			this.stream.push({ type: "text_start", contentIndex: this.getContentIndex(this.textBlock), partial: this.output });
		}
		return this.textBlock;
	}

	/**
	 * 取当前思考块，不存在则创建并推 thinking_start。
	 * @param thinkingSignature 推理字段名（回放签名）。
	 * @returns 当前思考块。
	 */
	private ensureThinkingBlock(thinkingSignature: string): ThinkingContent {
		if (!this.thinkingBlock) {
			this.thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
			this.blocks.push(this.thinkingBlock);
			this.stream.push({ type: "thinking_start", contentIndex: this.getContentIndex(this.thinkingBlock), partial: this.output });
		}
		return this.thinkingBlock;
	}

	/**
	 * 按 index（缺省按 id）查找已存在的 toolCall 块。
	 * 两个键都缺失时回退到最近一个 toolCall 块：部分兼容端点在参数续传 chunk 上省略
	 * index/id，此时新建块会把一次调用的 arguments 碎片化（静默退化为 {}）。
	 * @param toolCall chunk 中的 tool_call 增量。
	 * @returns 已存在的块；找不到返回 undefined。
	 */
	private findToolCallBlock(toolCall: ChatCompletionChunkToolCall): StreamingToolCallBlock | undefined {
		if (typeof toolCall.index === "number") {
			const block = this.toolCallBlocksByIndex.get(toolCall.index);
			if (block) return block;
		}
		if (toolCall.id) {
			return this.toolCallBlocksById.get(toolCall.id);
		}
		// 仅在两个键都缺失时才回退；带未知 id/index 的增量仍是新调用。
		if (typeof toolCall.index !== "number" && !toolCall.id) {
			return this.lastToolCallBlock ?? undefined;
		}
		return undefined;
	}

	/**
	 * 取 tool_call 增量对应的块，不存在则创建并推 toolcall_start。
	 * @param toolCall chunk 中的 tool_call 增量。
	 * @returns 对应的流式 toolCall 块。
	 */
	private ensureToolCallBlock(toolCall: ChatCompletionChunkToolCall): StreamingToolCallBlock {
		const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
		const name = toolCall.function?.name ?? "";
		let block = this.findToolCallBlock(toolCall);
		if (!block) {
			block = { type: "toolCall", id: toolCall.id || "", name, arguments: {}, partialArgs: "", streamIndex };
			this.blocks.push(block);
			this.stream.push({ type: "toolcall_start", contentIndex: this.getContentIndex(block), partial: this.output });
		}
		if (streamIndex !== undefined) {
			block.streamIndex = streamIndex;
			this.toolCallBlocksByIndex.set(streamIndex, block);
		}
		if (toolCall.id) {
			this.toolCallBlocksById.set(toolCall.id, block);
		}
		if (!block.name && name) {
			block.name = name;
		}
		this.lastToolCallBlock = block;
		return block;
	}

	/**
	 * 收尾所有块：推 text_end / thinking_end / toolcall_end，
	 * toolCall 的 partialArgs 在此解析为 arguments 并删除临时字段。
	 */
	finishAll(): void {
		for (const block of this.blocks) {
			const contentIndex = this.getContentIndex(block);
			if (contentIndex === -1) continue;
			if (block.type === "text") {
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
			} else if (block.type === "thinking") {
				this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
			} else if (block.type === "toolCall") {
				block.arguments = parseStreamingJson(block.partialArgs);
				delete block.partialArgs;
				delete block.streamIndex;
				this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
			}
		}
	}
}

/**
 * 剥离内容块上的流式临时字段（错误/中断路径使用，保证回放只携带解析后的 arguments）。
 * @param output 累积中的 AssistantMessage。
 */
export function stripStreamingScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		const scratch = block as { partialArgs?: string; streamIndex?: number };
		delete scratch.partialArgs;
		delete scratch.streamIndex;
	}
}
