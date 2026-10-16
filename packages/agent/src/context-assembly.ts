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

/**
 * 由装配结果 + 裁剪结果 + 预算配置构造一份结构化预算指标。
 * 纯函数：无 IO、无随机，可单测；分母用 max(x, 1) 保证定义为 0 时口径良好。
 *
 * @param assembled 裁剪前（装配后）的记忆集合，用于取 totalTokens 分母。
 * @param limited 预算裁剪后的记忆集合，用于取 kept 块与注入 token。
 * @param settings 预算配置，用于取档位与预算上限。
 * @returns 一份 ContextBudgetReport（命中率/丢弃率均落在 [0,1]）。
 */
export function buildBudgetReport(
	assembled: AssembledMemory,
	limited: AssembledMemory,
	settings: ContextBudgetSettings,
): ContextBudgetReport {
	const budgetTokens = computeMemoryBudgetTokens(settings);
	const injectedTokens = limited.totalTokens;
	const retrievedAvailable = assembled.retrieved.length;
	const retrievedKept = limited.retrieved.length;
	const retrievedDiscarded = retrievedAvailable - retrievedKept;

	// 分母用装配后总量；无任何记忆时分子分母同为 0，max(.,1) 使结果定义良好（=0）。
	const memoryHitRate = injectedTokens / Math.max(assembled.totalTokens, 1);
	// 检索丢弃率：分母为可供注入的检索块数，0 块时定义良好（=0）。
	const discardRate = retrievedDiscarded / Math.max(retrievedAvailable, 1);

	return {
		budgetTokens,
		injectedTokens,
		workingKept: limited.working !== null,
		retrievedKept,
		retrievedDiscarded,
		retrievedAvailable,
		memoryHitRate,
		discardRate,
		tier: settings.tier,
	};
}

/** summarizeBudgetReports 的聚合结果（eval/dashboard 一行指标）。 */
export interface BudgetSummary {
	/** 样本数（report 份数）。 */
	count: number;
	/** 平均记忆命中率。 */
	averageMemoryHitRate: number;
	/** 平均检索丢弃率。 */
	averageDiscardRate: number;
	/** 注入 token 超过预算上限的份数（理论上应为 0，作为预算纪律的健全性校验）。 */
	overBudgetCount: number;
	/** 出现检索被丢弃（discardRate > 0）的份数。 */
	discardedCount: number;
}

/**
 * 把多份 ContextBudgetReport 聚合为 eval/dashboard 可用的一行指标。
 * 纯函数：对命中率/丢弃率取均值，并统计超预算与丢弃发生次数。
 *
 * @param reports 多次 transform 产出的预算指标（顺序无关）。
 * @returns 聚合结果；空数组返回全 0 的零值聚合（不抛错）。
 */
export function summarizeBudgetReports(reports: ContextBudgetReport[]): BudgetSummary {
	if (reports.length === 0) {
		return {
			count: 0,
			averageMemoryHitRate: 0,
			averageDiscardRate: 0,
			overBudgetCount: 0,
			discardedCount: 0,
		};
	}

	let hitSum = 0;
	let discardSum = 0;
	let overBudgetCount = 0;
	let discardedCount = 0;
	for (const r of reports) {
		hitSum += r.memoryHitRate;
		discardSum += r.discardRate;
		// 注入量应恒 <= 预算上限；一旦越过说明裁剪逻辑回归，作为健全性信号计数。
		if (r.injectedTokens > r.budgetTokens) overBudgetCount++;
		if (r.discardRate > 0) discardedCount++;
	}

	return {
		count: reports.length,
		averageMemoryHitRate: hitSum / reports.length,
		averageDiscardRate: discardSum / reports.length,
		overBudgetCount,
		discardedCount,
	};
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

/**
 * 一次上下文装配的结构化预算指标（Context 预算可观测化的数据载体）。
 *
 * 设计取舍：本结构只描述「装配 + 预算裁剪」的**结果**，不耦合任何记忆/运行层；
 * 它通过 ContextAssemblerOptions.recordBudgetMetric 回调向外 emit，调用方（eval/
 * dashboard）自行聚合，模块本身不 import memory/trace（保持既有解耦原则）。
 *
 * 口径说明：
 * - memoryHitRate（记忆命中率）：injectedTokens / max(assembled.totalTokens, 1)。
 *   以「装配后、裁剪前」的总量为分母，度量「想注入的记忆有多大比例真正进了预算」，
 *   越接近 1 说明预算越宽松/记忆越精简。分母为 0（无任何记忆）时定义良好，返回 0。
 * - discardRate（检索丢弃率）：retrievedDiscarded / max(retrievedAvailable, 1)。
 *   以「可供注入的检索块」为分母，度量检索记忆被预算裁剪的比例；分母 0 时返回 0。
 */
export interface ContextBudgetReport {
	/** 本次记忆区 token 上限（computeMemoryBudgetTokens 结果）。 */
	budgetTokens: number;
	/**
	 * 实际注入的块 token 之和（kept 块）。
	 * userMessage 模式下即前置到上下文的记忆消息 token 量；
	 * systemPrompt 模式下为 buildSystemPromptWithMemory 可注入的量（transform 内未真正拼接）。
	 */
	injectedTokens: number;
	/** 工作记忆是否被保留（预算允许且非空）。 */
	workingKept: boolean;
	/** 实际保留的检索记忆块数。 */
	retrievedKept: number;
	/** 因超预算被丢弃的检索记忆块数。 */
	retrievedDiscarded: number;
	/** 可供注入的检索记忆块总数（provider 返回且非空）。 */
	retrievedAvailable: number;
	/** 记忆命中率，取值 [0,1]，口径见类型注释。 */
	memoryHitRate: number;
	/** 检索丢弃率，取值 [0,1]，口径见类型注释。 */
	discardRate: number;
	/** 当前预算档位。 */
	tier: ContextBudgetTier;
}

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
	/**
	 * 预算指标回调 sink：每次 transform 调用都会 emitting 一份 ContextBudgetReport。
	 * 解耦暴露：指标通过回调流出，本模块不耦合运行层/memory/trace；集成方（eval/
	 * dashboard）订阅此回调即可聚合命中率/丢弃率，无需改动装配内核。
	 */
	recordBudgetMetric?: (report: ContextBudgetReport) => void;
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
 * 可观测性：每次调用都会通过 options.recordBudgetMetric 回调 emit 一份
 * ContextBudgetReport（含 budgetTokens / injectedTokens / 各 kept/discarded 计数 /
 * memoryHitRate / discardRate / tier），与注入路径解耦，供 eval/dashboard 聚合
 * 「记忆命中率」「检索丢弃率」等数字证据（见 docs/v1.2/01-agent-engineering-philosophy.md §4 P1）。
 *
 * @param options 记忆提供者回调 + 预算配置（可含 recordBudgetMetric）。
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

		// 每次 transform 调用都产出一份结构化预算指标，供 eval/dashboard 聚合。
		// 与注入路径解耦：无论是否真正注入、是否无记忆，均 emit 一份（命中率/丢弃率分母定义良好）。
		const report = buildBudgetReport(assembled, limited, settings);
		options.recordBudgetMetric?.(report);

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
