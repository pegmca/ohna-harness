/**
 * 上下文 token 估算：对齐 pi-ai `src/utils/estimate.ts` 的裁剪版。
 * 供 simple-options 的 maxTokens 钳制使用；按 4 字符 ≈ 1 token 粗估，
 * 有最近一条 assistant usage 时以它为基准再累加尾部消息。
 * 与 pi 的差异：不处理 ToolResultMessage.addedToolNames（裁剪掉的字段）。
 */
import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.js";

/** 上下文 token 估算结果。 */
export interface ContextUsageEstimate {
	/** 估算的总上下文 token 数。 */
	tokens: number;
	/** 最近一条适用 assistant usage 上报的 token 数。 */
	usageTokens: number;
	/** 该 usage 之后消息的估算 token 数。 */
	trailingTokens: number;
	/** 提供 usage 的消息下标；没有则为 null。 */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * 从 usage 计算上下文总 token（totalTokens 优先，否则分项求和）。
 * @param usage 一次 assistant 响应的用量。
 * @returns 上下文 token 数。
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 安全的 JSON 序列化（循环引用等异常不抛出）。
 * @param value 任意值。
 * @returns 序列化字符串。
 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/**
 * 估算文本/图片内容块的字符数（图片按固定字符数折算）。
 * @param content 字符串或内容块数组。
 * @returns 估算字符数。
 */
function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

/**
 * 按 4 字符 1 token 估算文本 token 数。
 * @param text 文本。
 * @returns 估算 token 数。
 */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 估算一条消息的 token 数。
 * @param message 消息。
 * @returns 估算 token 数。
 */
export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "user") return Math.ceil(estimateTextAndImageContentChars(message.content) / CHARS_PER_TOKEN);
	if (message.role === "toolResult") {
		return Math.ceil(estimateTextAndImageContentChars(message.content) / CHARS_PER_TOKEN);
	}

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 找最近一条可代表当前前缀的 assistant usage（aborted/error 及被更新前缀消息覆盖的不算）。
 * @param messages 消息列表。
 * @returns usage 与其下标；没有则 undefined。
 */
function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// 该响应之后插入了更新的前缀消息（如压缩摘要），其 usage 不能描述当前前缀。
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/**
 * 估算消息列表 token：优先以最近 usage 为基准，否则逐条粗估。
 * @param messages 消息列表。
 * @returns 估算结果。
 */
function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * 估算工具定义的 token 开销（按 JSON 序列化长度粗估）。
 * @param tools 工具列表。
 * @returns 估算 token 数。
 */
function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

/**
 * 估算整个 Context 的 token 占用（消息 + systemPrompt + 工具定义）。
 * @param context 请求上下文。
 * @returns 估算结果。
 */
export function estimateContextTokens(context: Context): ContextUsageEstimate {
	const estimate = estimateMessages(context.messages);
	if (estimate.lastUsageIndex !== null) {
		// 有 usage 基准时，systemPrompt 与工具已包含在上报的 input 里，不重复计。
		return estimate;
	}

	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
