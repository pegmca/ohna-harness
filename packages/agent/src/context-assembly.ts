/**
 * 分层上下文装配器（Context Engineering 的 P1 落地）。
 *
 * 设计目标：把「喂给 LLM 的上下文」当成稀缺资源做体系化装配，而非随手拼 prompt。
 * 上下文由四层组成（对齐 Anthropic《Effective Context Engineering》思想，并借鉴
 * pi-agent 的 compaction 结构化摘要概念）：
 *   (1) system prompt     —— 系统提示（由 AgentContext 持有，本模块只负责记忆区拼接）；
 *   (2) working memory     —— 工作记忆（短期、上下文内的可读状态，由回调提供）；
 *   (3) retrieved memory   —— 检索记忆（来自 RAG / 长期记忆，由回调提供，P2 注入）；
 *   (4) compaction summary —— 压缩摘要（已在会话里的 CompactionMessage，沿用 convertToLlm）。
 *
 * 解耦原则：本模块**不 import 任何 memory 包**，只接受 provider 回调
 * （getWorkingMemory / retrieveMemory）。这样 P1（装配）与 P2（记忆）在集成时组合，
 * 各自独立演化。记忆块一律用围栏（fenced）区块清晰标注（[工作记忆] / [检索记忆 N]），
 * 且只有落在「context token 预算分级」内才注入——上下文超预算则整块丢弃。
 *
 * 与现有 loop 的关系：本模块产出的 transform 直接挂到 AgentLoopConfig.transformContext
 * （agent-loop.ts:307），在每次 LLM 调用前把记忆拼成一条 user 消息前置；CompactionMessage
 * 等既有消息原样保留，由 convertToLlm 负责转 user 消息（见 convert.ts）。
 */
import type { UserMessage } from "@aiagent/ai";
import { estimateTextTokens } from "@aiagent/ai";
import type { AgentMessage } from "./types.js";

/** 上下文预算档位：记忆区可占「可用窗口」的比例由档位决定。 */
export type ContextBudgetTier = "low" | "medium" | "high";

/** 各档位记忆区占可用窗口的默认比例（保守，避免记忆挤占主对话）。 */
const TIER_MEMORY_RATIO: Record<ContextBudgetTier, number> = {
	low: 0.05,
	medium: 0.15,
	high: 0.3,
};

/** 上下文预算配置：由模型窗口 + 预留 token + 档位推导记忆可注入 token 上限。 */
export interface ContextBudgetSettings {
	/** 当前预算档位。 */
	tier: ContextBudgetTier;
	/** 模型上下文窗口（token）。 */
	contextWindow: number;
	/** 为下一次响应（含工具结果/生成）预留的 token，记忆不得占用。 */
	reserveTokens: number;
	/**
	 * 覆盖各档位的记忆占比。缺省用 TIER_MEMORY_RATIO。
	 * 例：{ high: 0.4 } 把 high 档提到 40%。
	 */
	tierRatios?: Partial<Record<ContextBudgetTier, number>>;
}

/** 默认上下文预算：中等档位、12.8 万窗口、预留 16384 token（与 compaction 默认值对齐）。 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetSettings = {
	tier: "medium",
	contextWindow: 128000,
	reserveTokens: 16384,
};

/** 工作记忆围栏标签（中英文双语，便于模型区分）。 */
const WORKING_MEMORY_LABEL = "工作记忆";
/** 检索记忆围栏标签前缀。 */
const RETRIEVED_MEMORY_LABEL = "检索记忆";

/**
 * 计算记忆区允许注入的 token 上限：可用窗口 = contextWindow - reserveTokens，
 * 再乘以当前档位比例。
 *
 * @param settings 预算配置。
 * @returns 记忆区可占的 token 上限（向下取整，下限为 0）。
 */
export function computeMemoryBudgetTokens(settings: ContextBudgetSettings): number {
	const ratio = settings.tierRatios?.[settings.tier] ?? TIER_MEMORY_RATIO[settings.tier];
	const available = Math.max(0, settings.contextWindow - settings.reserveTokens);
	return Math.floor(available * ratio);
}

/** 单个记忆块：已围栏化、已知 token 成本，便于按预算裁剪。 */
export interface MemoryBlock {
	/** 区块标题（如「工作记忆」「检索记忆 1」）。 */
	title: string;
	/** 已围栏化的完整正文（含 [标签]…[/标签]）。 */
	content: string;
	/** 估算 token 数（用于预算裁剪）。 */
	tokens: number;
}

/** 装配后的记忆集合：工作记忆（至多一条）+ 检索记忆（零到多条）。 */
export interface AssembledMemory {
	/** 工作记忆块；无则 null。 */
	working: MemoryBlock | null;
	/** 检索记忆块（每条一段/一文档，独立可裁）。 */
	retrieved: MemoryBlock[];
	/** 装配后记忆总 token 数。 */
	totalTokens: number;
}

/** assembleMemoryBlocks 的输入：原始字符串，尚未围栏化。 */
export interface AssembleMemoryInput {
	/** 工作记忆原文（短期状态）。空/空白则忽略。 */
	workingMemory?: string | null;
	/** 检索记忆原文列表（每条一文档）。空项被过滤。 */
	retrievedMemory?: Array<string | null> | null;
}

/**
 * 用围栏把区块正文包裹起来，确保模型能清晰区分「记忆」与「真实对话」。
 *
 * @param label 区块标签（如「工作记忆」）。
 * @param text 区块正文。
 * @returns `[label]\ntext\n[/label]` 形式的围栏文本。
 */
function fence(label: string, text: string): string {
	return `[${label}]\n${text}\n[/${label}]`;
}

/**
 * 把原始记忆字符串装配成带围栏、已知 token 成本的 MemoryBlock 集合。
 * 纯函数：无 IO、无回调、可单测。
 *
 * @param input 原始工作/检索记忆文本。
 * @returns 装配后的 AssembledMemory（已围栏化并计算 totalTokens）。
 */
export function assembleMemoryBlocks(input: AssembleMemoryInput): AssembledMemory {
	const workingText = input.workingMemory?.trim();
	const working: MemoryBlock | null = workingText
		? (() => {
				const content = fence(WORKING_MEMORY_LABEL, workingText);
				return { title: WORKING_MEMORY_LABEL, content, tokens: estimateTextTokens(content) };
			})()
		: null;

	const retrieved: MemoryBlock[] = (input.retrievedMemory ?? [])
		.filter((text): text is string => !!text && text.trim().length > 0)
		.map((text, index) => {
			const label = `${RETRIEVED_MEMORY_LABEL} ${index + 1}`;
			const content = fence(label, text.trim());
			return { title: label, content, tokens: estimateTextTokens(content) };
		});

	const totalTokens =
		(working?.tokens ?? 0) + retrieved.reduce((sum, block) => sum + block.tokens, 0);

	return { working, retrieved, totalTokens };
}

/**
 * 把装配好的记忆拼进 system prompt：追加一个「## 记忆上下文」段，依次放入工作记忆与检索记忆。
 * 记忆为空时原样返回 baseSystemPrompt（不污染 prompt）。
 *
 * 注意：本函数用于「持有 systemPrompt 的上层」手动拼接；transformContext 钩子拿不到
 * systemPrompt（它只接收 messages），所以 transform 默认用 userMessage 方式注入，见
 * createContextAssemblyTransform。
 *
 * @param baseSystemPrompt 原始系统提示。
 * @param blocks 装配后的记忆。
 * @returns 拼接记忆后的系统提示；无记忆时返回原 prompt。
 */
export function buildSystemPromptWithMemory(baseSystemPrompt: string, blocks: AssembledMemory): string {
	const sections: string[] = [];
	if (blocks.working) sections.push(blocks.working.content);
	for (const block of blocks.retrieved) sections.push(block.content);
	if (sections.length === 0) return baseSystemPrompt;

	const memorySection = ["## 记忆上下文", ...sections].join("\n\n");
	return `${baseSystemPrompt}\n\n${memorySection}`;
}

/**
 * 把装配好的记忆格式化为一条可前置的 user 消息文本（带「仅供参考」声明）。
 * 记忆为空时返回 null（调用方据此跳过注入）。
 *
 * @param blocks 装配后的记忆。
 * @returns 记忆消息全文；无记忆返回 null。
 */
export function formatMemoryAsUserMessage(blocks: AssembledMemory): string | null {
	const sections: string[] = [];
	if (blocks.working) sections.push(blocks.working.content);
	for (const block of blocks.retrieved) sections.push(block.content);
	if (sections.length === 0) return null;

	return [
		"[以下为系统注入的工作/检索记忆，仅供参考，不替代用户最新指令]",
		...sections,
	].join("\n\n");
}

/**
 * 按 context token 预算分级裁剪记忆块：记忆区总 token 不得超过 computeMemoryBudgetTokens。
 * 优先级：工作记忆先保留，再按序填充检索记忆直到预算耗尽（检索记忆可独立丢弃，故从尾部裁）。
 *
 * @param blocks 装配后的记忆。
 * @param settings 预算配置（含 contextWindow / reserveTokens / tier）。
 * @param contextWindow 模型上下文窗口（覆盖 settings.contextWindow，便于按实际模型注入）。
 * @returns 裁剪后仍在预算内的 AssembledMemory。
 */
export function limitContextByBudget(
	blocks: AssembledMemory,
	settings: ContextBudgetSettings,
	contextWindow: number,
): AssembledMemory {
	const budget = computeMemoryBudgetTokens({ ...settings, contextWindow });
	let used = 0;

	// 工作记忆最贴近当前任务，优先保留（放得下才放）。
	let working: MemoryBlock | null = null;
	if (blocks.working && used + blocks.working.tokens <= budget) {
		working = blocks.working;
		used += blocks.working.tokens;
	}

	const retrieved: MemoryBlock[] = [];
	for (const block of blocks.retrieved) {
		if (used + block.tokens <= budget) {
			retrieved.push(block);
			used += block.tokens;
		}
	}

	return { working, retrieved, totalTokens: used };
}

/** 记忆提供者回调：工作记忆（同步/异步均可返回）。 */
export type WorkingMemoryProvider = () => string | null | Promise<string | null>;
/** 记忆提供者回调：检索记忆（RAG / 长期记忆），可接收查询与 abort 信号。 */
export type RetrievedMemoryProvider = (
	query?: string,
	signal?: AbortSignal,
) => string[] | Promise<string[]>;

/** 记忆注入方式。 */
export type MemoryInjectionMode = "userMessage" | "systemPrompt";

/** createContextAssemblyTransform 的配置（provider 回调 + 预算）。 */
export interface ContextAssemblerOptions {
	/**
	 * 工作记忆提供者。缺省视为无工作记忆。
	 * 解耦 P2：真正的状态来源（对话草稿、待办、工具副作用）由集成方注入。
	 */
	getWorkingMemory?: WorkingMemoryProvider;
	/**
	 * 检索记忆提供者：给定查询返回相关文档片段列表。缺省视为无检索记忆。
	 * 解耦 P2：RAG / 向量库在集成时实现并注入。
	 */
	retrieveMemory?: RetrievedMemoryProvider;
	/**
	 * 从当前消息推导检索查询（默认取最近一条 user 消息文本）。
	 * 在 transformContext 钩子内调用，只读 messages。
	 */
	deriveQuery?: (messages: AgentMessage[]) => string | undefined;
	/** 预算配置（必填）：决定记忆档位与可注入 token 上限。 */
	budget: ContextBudgetSettings;
	/**
	 * 注入方式：
	 * - "userMessage"（默认）：前置一条带围栏的记忆 user 消息（transformContext 可达）；
	 * - "systemPrompt"：transformContext 钩子拿不到 systemPrompt，无法真正拼接，
	 *   故该模式下 transform 退化为原样返回——真正拼接请用 buildSystemPromptWithMemory。
	 */
	injectMode?: MemoryInjectionMode;
}

/**
 * 默认查询推导：取序列中最后一条 user 消息的纯文本作为检索 query。
 * CompactionMessage / assistant / toolResult 均忽略。
 *
 * @param messages 当前消息序列。
 * @returns 最近一条 user 消息文本；无则 undefined。
 */
export function defaultDeriveQuery(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user") {
			const content = message.content;
			return typeof content === "string"
				? content
				// 图片块无 text 字段，只拼接文本块（与 estimateMessageTokens 的口径一致）。
				: content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		}
	}
	return undefined;
}

/**
 * 生成挂到 AgentLoopConfig.transformContext 的分层上下文装配变换：
 * 每次 LLM 调用前，安全地（回调失败不破坏「不得抛错」契约）拉取工作/检索记忆，
 * 装配并按预算裁剪，预算允许时前置一条记忆 user 消息；预算不足或无记忆则原样返回。
 *
 * 不破坏既有行为：返回的是**新数组**（前置记忆消息），不就地改写 context.messages，
 * 因此不会在每轮 transform 中重复堆积记忆；CompactionMessage 等原消息原样保留，
 * 由 convertToLlm 转成 user 消息（见 convert.ts:33）。
 *
 * @param options 记忆提供者回调 + 预算配置。
 * @returns transformContext 兼容的钩子函数。
 */
export function createContextAssemblyTransform(
	options: ContextAssemblerOptions,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	const injectMode: MemoryInjectionMode = options.injectMode ?? "userMessage";
	const settings: ContextBudgetSettings = options.budget;
	const deriveQuery = options.deriveQuery ?? defaultDeriveQuery;

	return async (messages, signal) => {
		// 回调失败不得抛出：退化为「无该记忆」，保证 transformContext 契约。
		let workingMemory: string | null = null;
		try {
			workingMemory = options.getWorkingMemory ? await options.getWorkingMemory() : null;
		} catch {
			workingMemory = null;
		}

		let retrievedMemory: string[] = [];
		try {
			const query = deriveQuery(messages);
			const result = options.retrieveMemory ? await options.retrieveMemory(query, signal) : [];
			retrievedMemory = Array.isArray(result) ? result : [];
		} catch {
			retrievedMemory = [];
		}

		const assembled = assembleMemoryBlocks({ workingMemory, retrievedMemory });
		const limited = limitContextByBudget(assembled, settings, settings.contextWindow);

		// 预算不足或无记忆：原样返回，不污染上下文、不破坏 CompactionMessage 处理。
		if (limited.working === null && limited.retrieved.length === 0) {
			return messages;
		}

		// 仅 userMessage 模式能在 transformContext 钩子内真正注入（前置一条记忆消息）。
		if (injectMode === "userMessage") {
			const text = formatMemoryAsUserMessage(limited);
			if (!text) return messages;
			const memoryMessage: UserMessage = {
				role: "user",
				content: text,
				timestamp: Date.now(),
			};
			return [memoryMessage, ...messages];
		}

		// systemPrompt 模式：钩子内无 systemPrompt，退化为原样返回（拼接见 buildSystemPromptWithMemory）。
		return messages;
	};
}
