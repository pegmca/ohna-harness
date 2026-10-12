/**
 * 记忆 Hook 工厂：把记忆读写挂载到 AgentLoopConfig 的挂载点。
 *
 * - `createMemoryRetrieveHook`：结构性兼容 `transformContext`，每轮把检索到的长期记忆
 *   以「前导 user 消息」注入本次 LLM 调用上下文（返回新数组，不原地修改、不写回持久历史，
 *   受 token 预算约束）。选择 transformContext 而非 prepareNextTurn：注入只对该次调用生效、
 *   不会逐轮累积污染对话历史。
 * - `createMemoryWriteHook`：结构性兼容 `afterToolCall`，把成功的工具结果/观察写回为
 *   EpisodeMemory（纯副作用，返回 undefined 不覆盖工具结果）。
 *
 * 兼容性说明：本包不 import @aiagent/agent，故用结构最小类型（MemoryMessage /
 * AgentContextLike / MemoryAfterToolCallContext 等）描述上下文。MemoryMessage 与 agent 包的
 * AgentMessage 结构等价，因此本包 hook 可被直接当作 AgentLoopConfig 的对应钩子使用。
 */
import { estimateMessageTokens, type Message } from "@aiagent/ai";
import type {
  AgentToolResultLike,
  EpisodeMemory,
  EpisodeType,
  MemoryAfterToolCallContext,
  MemoryBudgetSettings,
  MemoryMessage,
  MemoryStore,
} from "./types.js";
import { DEFAULT_MEMORY_BUDGET } from "./types.js";

/**
 * 从一条未知形状的消息中抽取可读文本（兼容 user / assistant / toolResult / compaction）。
 * messages 在边界上是 unknown[]，按 role 字段做防御式收窄，避免非三元组消息导致崩溃。
 *
 * @param message 任意消息对象（或 null/undefined）。
 * @returns 拼接后的纯文本；无法识别时返回空串。
 */
function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const messageRecord = message as Record<string, unknown>;
  const role = messageRecord.role;

  if (role === "user" || role === "toolResult") {
    const content = messageRecord.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as Array<{ text?: string }>).map((block) => block?.text ?? "").join(" ");
    }
    return "";
  }
  if (role === "assistant") {
    const content = messageRecord.content;
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string; name?: string }>)
        .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "toolCall" ? (block.name ?? "") : ""))
        .join(" ");
    }
    return "";
  }
  if (role === "compaction") {
    return typeof messageRecord.summary === "string" ? messageRecord.summary : "";
  }
  return "";
}

/**
 * 安全估算单条消息 token：优先复用 @aiagent/ai 的 estimateMessageTokens（4 字符≈1 token），
 * 遇到非三元组消息（如 compaction）估算抛错时回退到 chars/4 兜底，保证 hook 不崩。
 *
 * @param message 任意消息对象。
 * @returns 估算 token 数。
 */
function estimateMessageTokensSafe(message: unknown): number {
  try {
    return estimateMessageTokens(message as Message);
  } catch {
    return Math.ceil(messageText(message).length / 4);
  }
}

/**
 * 从上下文抽取检索 query：优先取最近一条 user 消息文本，回退到最近一条 assistant 文本。
 *
 * @param messages 对话消息序列（结构最小形状）。
 * @returns 检索用的查询文本；都没有时返回空串。
 */
function recentUserQuery(messages: MemoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message && message.role === "user") return messageText(message);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message && message.role === "assistant") return messageText(message);
  }
  return "";
}

/**
 * 把检索结果渲染成带围栏的注入文本（前导 user 消息内容）。
 *
 * @param records 已过滤的检索结果（按 score 降序）。
 * @param label 围栏标签（如「检索记忆」）。
 * @returns 注入用文本，含起止围栏，便于模型区分记忆与实时对话。
 */
function renderInjection(records: Array<{ record: EpisodeMemory; score: number }>, label: string): string {
  const lines = records.map((item, index) => `${index + 1}. [${item.record.type}] ${item.record.content}`);
  return `[${label}]\n以下是与当前对话相关的历史记忆，仅供参考：\n${lines.join("\n")}\n[/${label}]`;
}

/** 检索 Hook 选项。 */
export interface MemoryRetrieveHookOptions {
  /** 预算覆盖（默认见 DEFAULT_MEMORY_BUDGET）。 */
  budget?: Partial<MemoryBudgetSettings>;
  /** 自定义从上下文抽取 query 的函数；缺省取最近 user 消息。 */
  buildQuery?: (messages: MemoryMessage[]) => string;
}

/**
 * 创建「检索注入」钩子（结构兼容 transformContext）。
 * 每轮从长期记忆检索 top-k，过滤低分结果，按 token 预算把记忆以一条前导 user 消息
 * 注入本次 LLM 调用上下文；预算不足或无可注入结果时返回原 messages（不注入）。
 *
 * 关键设计：返回 **新数组**（`[injection, ...messages]`），不原地修改入参，也不写回持久
 * 对话历史——注入只对当次 LLM 调用生效，下一轮重新派生，避免记忆块逐轮累积污染上下文。
 *
 * @param store 记忆存储。
 * @param options 预算与 query 抽取自定义。
 * @returns 可直接挂到 AgentLoopConfig.transformContext 的函数。
 */
export function createMemoryRetrieveHook(
  store: MemoryStore,
  options: MemoryRetrieveHookOptions = {},
): (messages: MemoryMessage[], signal?: AbortSignal) => Promise<MemoryMessage[]> {
  const budget: MemoryBudgetSettings = { ...DEFAULT_MEMORY_BUDGET, ...options.budget };

  return async (messages) => {
    const query = options.buildQuery ? options.buildQuery(messages) : recentUserQuery(messages);
    if (!query.trim()) return messages;

    // retrieve 是异步接口（未来 PG/向量实现需 IO），本地实现内部同步计算。
    const retrieved = await store.retrieve(query, budget.maxResults);
    const kept = retrieved.filter((item) => item.score >= budget.minScore);
    if (kept.length === 0) return messages;

    const injectionText = renderInjection(kept, budget.fenceLabel);
    const injection: Message = {
      role: "user",
      content: injectionText,
      timestamp: Date.now(),
    };
    const injectionTokens = estimateMessageTokens(injection);

    // 预算判定：当前上下文 token + 注入 token 不超过上限才注入。
    const currentTokens = messages.reduce<number>(
      (sum, message) => sum + estimateMessageTokensSafe(message),
      0,
    );
    if (currentTokens + injectionTokens > budget.maxTokens) {
      return messages;
    }

    // 返回新数组：注入仅对当次 LLM 调用生效，不污染持久对话历史。
    return [injection, ...messages];
  };
}

/**
 * 从工具结果中抽取 episode 文本（默认取 text 内容块拼接）。
 *
 * @param result 工具结果（结构最小形状）。
 * @returns 拼接后的文本。
 */
function defaultResultText(result: AgentToolResultLike): string {
  const parts = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "");
  return parts.join(" ").trim();
}

/** 写回 Hook 选项。 */
export interface MemoryWriteHookOptions {
  /** 是否把工具错误也记作 episode；默认 false（只记成功结果，避免噪声）。 */
  recordErrors?: boolean;
  /** 自定义从 result 抽取 episode 文本；缺省取 text 内容块。 */
  extractText?: (result: AgentToolResultLike) => string;
  /** episode 类型标签；默认 "result"。 */
  episodeType?: EpisodeType;
}

/**
 * 创建「工具结果写回」钩子（结构兼容 afterToolCall）。
 * 把成功的工具结果/观察写回为一条 EpisodeMemory（长期层）。纯副作用，返回 undefined，
 * 不覆盖工具执行结果（符合 AgentLoopConfig.afterToolCall 覆盖语义——缺省字段保留原结果）。
 *
 * @param store 记忆存储。
 * @param options 错误记录开关、文本抽取、类型标签。
 * @returns 可直接挂到 AgentLoopConfig.afterToolCall 的函数。
 */
export function createMemoryWriteHook(
  store: MemoryStore,
  options: MemoryWriteHookOptions = {},
): (context: MemoryAfterToolCallContext) => undefined {
  const episodeType: EpisodeType = options.episodeType ?? "result";

  return (context) => {
    if (context.isError && !options.recordErrors) return undefined;

    const text = options.extractText ? options.extractText(context.result) : defaultResultText(context.result);
    if (!text.trim()) return undefined;

    const episode: EpisodeMemory = {
      id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      content: text,
      type: episodeType,
      metadata: { toolArgs: context.args, isError: context.isError },
    };
    // 写回为长期记忆；不 await（钩子不应阻塞 turn 收尾），错误在 store 内部兜底。
    void store.saveEpisode(episode);
    return undefined;
  };
}
