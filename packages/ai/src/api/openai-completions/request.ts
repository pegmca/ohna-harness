/**
 * openai-completions 请求构造：对齐 pi-ai `src/api/openai-completions.ts` 的裁剪版。
 * 负责 compat 解析、Context → chat completions 消息/工具/参数映射、usage 与 finish_reason 归一化。
 * 与 pi 的差异：去掉 OAuth、cache_control、session 亲和、deferred tools、grammar/custom tools、
 * 路由偏好等；thinking 格式只保留 openai/deepseek/qwen 三档；不做 baseUrl 自动探测。
 */
import type {
	Context,
	ImageContent,
	Message,
	Model,
	OpenAICompletionsCompat,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../../types.js";
import type { ChatCompletionChunkUsage } from "./sse.js";

/** OpenAI 请求消息（裸 fetch 下的最小结构类型）。 */
export interface ChatRequestMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content?: unknown;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	name?: string;
	/** 推理字段回放（如 reasoning_content），键名来自 thinkingSignature。 */
	[key: string]: unknown;
}

/** chat completions 流式请求体（宽松形状，字段按 compat 条件填充）。 */
export type ChatCompletionRequestParams = Record<string, unknown>;

/** thinking 档位字段：openai-completions 特有的流式选项。 */
export interface OpenAICompletionsExtraOptions {
	toolChoice?: unknown;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

/** 填好默认值的 compat（默认不做自动探测，显式声明优先）。 */
export interface ResolvedOpenAICompletionsCompat {
	supportsDeveloperRole: boolean;
	supportsReasoningEffort: boolean;
	supportsUsageInStreaming: boolean;
	maxTokensField: "max_completion_tokens" | "max_tokens";
	requiresThinkingAsText: boolean;
	thinkingFormat: "openai" | "deepseek" | "qwen";
}

/**
 * 解析模型 compat：全部取显式声明值，缺失用保守默认值（不做 pi 的 baseUrl 自动探测）。
 * @param model 模型目录条目。
 * @returns 填好默认值的 compat。
 */
export function resolveCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const compat: OpenAICompletionsCompat = model.compat ?? {};
	return {
		supportsDeveloperRole: compat.supportsDeveloperRole ?? false,
		supportsReasoningEffort: compat.supportsReasoningEffort ?? true,
		supportsUsageInStreaming: compat.supportsUsageInStreaming ?? true,
		maxTokensField: compat.maxTokensField ?? "max_completion_tokens",
		requiresThinkingAsText: compat.requiresThinkingAsText ?? false,
		thinkingFormat: compat.thinkingFormat ?? "openai",
	};
}

/**
 * 清洗孤立 UTF-16 代理对，避免 JSON.stringify/上游解析报错。
 * @param text 原始文本。
 * @returns 替换孤立代理项后的文本。
 */
export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

/**
 * 映射 user 消息为 chat completions 消息（空内容数组返回 null 跳过）。
 * @param msg 用户消息。
 * @returns 请求消息或 null。
 */
function convertUserMessage(msg: Extract<Message, { role: "user" }>): ChatRequestMessage | null {
	if (typeof msg.content === "string") {
		return { role: "user", content: sanitizeSurrogates(msg.content) };
	}
	const content = msg.content.map((item) =>
		item.type === "text"
			? { type: "text", text: sanitizeSurrogates(item.text) }
			: { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } },
	);
	if (content.length === 0) return null;
	return { role: "user", content };
}

/**
 * 映射 assistant 消息：文本始终以纯字符串回放（数组形式会让部分模型模仿内容块结构）；
 * thinking 块按 thinkingSignature 指定的键名回放（多轮思考连续性），requiresThinkingAsText 时
 * 退化为纯文本；无内容且无工具调用的消息返回 null 跳过（如被中断的空响应）。
 * @param msg assistant 消息。
 * @param compat 已解析的 compat。
 * @returns 请求消息或 null。
 */
function convertAssistantMessage(
	msg: Extract<Message, { role: "assistant" }>,
	compat: ResolvedOpenAICompletionsCompat,
): ChatRequestMessage | null {
	const assistantMsg: ChatRequestMessage = { role: "assistant", content: null };

	const textParts = msg.content
		.filter(isTextContentBlock)
		.filter((block) => block.text.trim().length > 0)
		.map((block) => sanitizeSurrogates(block.text));
	const assistantText = textParts.join("");

	const thinkingBlocks = msg.content
		.filter(isThinkingContentBlock)
		.filter((block) => block.thinking.trim().length > 0);
	if (thinkingBlocks.length > 0) {
		if (compat.requiresThinkingAsText) {
			// 退化为纯文本回放（不加标签，避免模型模仿）。
			const thinkingText = thinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n");
			assistantMsg.content = [thinkingText, ...textParts].filter((part) => part.length > 0).join("");
		} else {
			if (assistantText.length > 0) assistantMsg.content = assistantText;
			// 用第一个 thinking 块的签名作为回放键名（如 reasoning_content）。
			const signature = thinkingBlocks[0].thinkingSignature;
			if (signature && signature.length > 0) {
				assistantMsg[signature] = thinkingBlocks.map((block) => block.thinking).join("\n");
			}
		}
	} else if (assistantText.length > 0) {
		assistantMsg.content = assistantText;
	}

	const toolCalls = msg.content.filter(isToolCallBlock);
	if (toolCalls.length > 0) {
		assistantMsg.tool_calls = toolCalls.map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
		}));
	}

	const content = assistantMsg.content;
	const hasContent = typeof content === "string" && content.length > 0;
	if (!hasContent && !assistantMsg.tool_calls) return null;
	return assistantMsg;
}

/**
 * 映射单条 toolResult 为 tool 消息（无文本时给占位内容）。
 * @param toolMsg 工具结果消息。
 * @returns 请求消息。
 */
function convertToolResultMessage(toolMsg: Extract<Message, { role: "toolResult" }>): ChatRequestMessage {
	const textResult = toolMsg.content
		.filter(isTextContentBlock)
		.map((block) => block.text)
		.join("\n");
	const hasImages = toolMsg.content.some(isImageContentBlock);
	const toolResultText = textResult.length > 0 ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
	return {
		role: "tool",
		content: sanitizeSurrogates(toolResultText),
		tool_call_id: toolMsg.toolCallId,
	};
}

/**
 * 展开从下标 i 开始的连续 toolResult 消息段。
 * @param messages 完整消息列表。
 * @param start 起始下标（指向第一条 toolResult）。
 * @returns [转换出的 tool 消息数组, 段结束后的下标]。
 */
function convertToolResultRun(messages: Message[], start: number): [ChatRequestMessage[], number] {
	const converted: ChatRequestMessage[] = [];
	let i = start;
	for (; i < messages.length && messages[i].role === "toolResult"; i++) {
		const toolMsg = messages[i];
		if (toolMsg.role !== "toolResult") break;
		converted.push(convertToolResultMessage(toolMsg));
	}
	return [converted, i];
}

/**
 * 把 Context 消息映射为 chat completions 消息数组。
 *
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param compat 已解析的 compat。
 * @returns chat completions 消息数组。
 */
export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
): ChatRequestMessage[] {
	const params: ChatRequestMessage[] = [];

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		params.push({ role: useDeveloperRole ? "developer" : "system", content: sanitizeSurrogates(context.systemPrompt) });
	}

	for (let i = 0; i < context.messages.length; i++) {
		const msg: Message = context.messages[i];

		if (msg.role === "user") {
			const converted = convertUserMessage(msg);
			if (converted) params.push(converted);
		} else if (msg.role === "assistant") {
			const converted = convertAssistantMessage(msg, compat);
			if (converted) params.push(converted);
		} else if (msg.role === "toolResult") {
			// 连续的 toolResult 逐条展开为 tool 消息。
			const [converted, next] = convertToolResultRun(context.messages, i);
			params.push(...converted);
			i = next - 1;
		}
	}

	return params;
}

/**
 * 把 Tool 列表映射为 chat completions tools 参数（parameters 原样透传为 JSON Schema）。
 * @param tools 工具列表。
 * @returns OpenAI tools 参数。
 */
export function convertTools(tools: Tool[]): Array<Record<string, unknown>> {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		},
	}));
}

/** buildParams 的输入选项子集。 */
export interface BuildParamsOptions {
	temperature?: number;
	maxTokens?: number;
	toolChoice?: unknown;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * 构造 chat completions 流式请求体。
 * thinking 参数按 compat.thinkingFormat 分三档：openai（reasoning_effort）、
 * deepseek（thinking: { type }，支持时附带 reasoning_effort）、qwen（enable_thinking）。
 *
 * @param model 模型目录条目。
 * @param context 请求上下文。
 * @param options 流式选项子集。
 * @param compat 已解析的 compat。
 * @returns 请求体。
 */
export function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: BuildParamsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionRequestParams {
	const params: ChatCompletionRequestParams = {
		model: model.id,
		messages: convertMessages(model, context, compat),
		stream: true,
	};

	if (compat.supportsUsageInStreaming) {
		params.stream_options = { include_usage: true };
	}

	if (options?.maxTokens) {
		params[compat.maxTokensField] = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(context.tools);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		applyThinkingParams(params, model, compat, options?.reasoningEffort);
	}

	return params;
}

/**
 * 按 compat.thinkingFormat 写入 thinking 参数：openai（reasoning_effort）、
 * deepseek（thinking: { type }，支持时附带 reasoning_effort）、qwen（enable_thinking）。
 * thinkingLevelMap 显式映射优先于档位原名。
 *
 * @param params 请求体（就地修改）。
 * @param model 模型目录条目。
 * @param compat 已解析的 compat。
 * @param effort thinking 档位；undefined 表示关闭。
 */
function applyThinkingParams(
	params: ChatCompletionRequestParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompletionsCompat,
	effort: BuildParamsOptions["reasoningEffort"],
): void {
	if (compat.thinkingFormat === "qwen") {
		params.enable_thinking = !!effort;
		return;
	}
	if (compat.thinkingFormat === "deepseek") {
		applyDeepseekThinkingParams(params, model, compat, effort);
		return;
	}
	applyOpenaiThinkingParams(params, model, compat, effort);
}

/**
 * deepseek 格式：thinking: { type: enabled/disabled }，支持时附带 reasoning_effort。
 * @param params 请求体（就地修改）。
 * @param model 模型目录条目。
 * @param compat 已解析的 compat。
 * @param effort thinking 档位；undefined 表示关闭。
 */
function applyDeepseekThinkingParams(
	params: ChatCompletionRequestParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompletionsCompat,
	effort: BuildParamsOptions["reasoningEffort"],
): void {
	if (effort) {
		params.thinking = { type: "enabled" };
	} else if (model.thinkingLevelMap?.off !== null) {
		params.thinking = { type: "disabled" };
	}
	if (effort && compat.supportsReasoningEffort) {
		params.reasoning_effort = model.thinkingLevelMap?.[effort] ?? effort;
	}
}

/**
 * openai 格式：reasoning_effort；off 映射存在时显式关闭。
 * @param params 请求体（就地修改）。
 * @param model 模型目录条目。
 * @param compat 已解析的 compat。
 * @param effort thinking 档位；undefined 表示关闭。
 */
function applyOpenaiThinkingParams(
	params: ChatCompletionRequestParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompletionsCompat,
	effort: BuildParamsOptions["reasoningEffort"],
): void {
	if (!compat.supportsReasoningEffort) return;
	if (effort) {
		params.reasoning_effort = model.thinkingLevelMap?.[effort] ?? effort;
		return;
	}
	const offValue = model.thinkingLevelMap?.off;
	if (typeof offValue === "string") {
		params.reasoning_effort = offValue;
	}
}

/**
 * 归一化流式 usage：cached_tokens 计为 cacheRead 并从 input 中扣除，cost 全 0（目录费率后续启用）。
 * @param rawUsage chunk 中的 usage 字段。
 * @returns 归一化 Usage。
 */
export function parseChunkUsage(rawUsage: ChatCompletionChunkUsage): Usage {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens 已包含 reasoning_tokens。
	const outputTokens = rawUsage.completion_tokens || 0;
	return {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * 映射 finish_reason 到统一 StopReason；异常 finish_reason 归为 error。
 * @param reason chunk 的 finish_reason。
 * @returns stopReason 与可选错误消息。
 */
export function mapStopReason(reason: string | null | undefined): { stopReason: StopReason; errorMessage?: string } {
	if (reason === null || reason === undefined) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}
