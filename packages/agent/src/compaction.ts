/**
 * 上下文压缩（compaction）：对齐 pi coding-agent/src/core/compaction/compaction.ts 的
 * 纯函数子集，裁剪为「线性消息 + 内存形态」版本（落库属阶段 3）。
 *
 * 语义照抄 pi：
 * - estimateTokens：chars/4 启发式（复用 @aiagent/ai 的 estimateMessageTokens）；
 * - estimateContextTokens：末条可用 assistant usage 为基准 + 尾部消息估算补齐；
 * - shouldCompact：contextTokens > contextWindow - reserveTokens 触发；
 * - prepareCompaction：从尾部累计 keepRecentTokens 找切点，切点绝不落在 toolResult 上，
 *   保证 AssistantMessage.toolCalls 与其 ToolResultMessage 同进同出不被截断；
 * - compact：纯函数，用摘要把被裁前缀替换成一条 CompactionMessage 置于队首。
 *
 * 与 pi 的差异：不做 LLM 摘要调用本身（摘要由注入的 summarizer 完成）、不做 turn 拆分
 * 前缀摘要、不做文件操作追踪；CompactionMessage 是内存消息类型，convertToLlm 负责转 user 消息。
 */
import { calculateContextTokens, estimateMessageTokens } from "@aiagent/ai";
import type { AgentMessage } from "./types.js";

/**
 * 压缩摘要消息：替代被裁掉的历史前缀，位于压缩后序列队首。
 * convertToLlm 把它转成一条 user 消息进入 LLM 上下文。
 */
export interface CompactionMessage {
  role: "compaction";
  /** 被裁前缀的结构化摘要文本。 */
  summary: string;
  /** 压缩前上下文估算 token 数（审计用）。 */
  tokensBefore: number;
  /** 被摘要替代的消息条数（审计用）。 */
  summarizedMessageCount: number;
  /** Unix 毫秒时间戳。 */
  timestamp: number;
}

/** 压缩触发与保留配置。 */
export interface CompactionSettings {
  enabled: boolean;
  /** 为下一次响应预留的 token 数；contextWindow - reserveTokens 是触发阈值。 */
  reserveTokens: number;
  /** 压缩时保留的最近消息 token 预算。 */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/**
 * 估算一条消息的 token 数（chars/4 启发式，偏保守）。
 *
 * @param message 消息（含 CompactionMessage）。
 * @returns 估算 token 数。
 */
export function estimateTokens(message: AgentMessage): number {
  if (message.role === "compaction") {
    return Math.ceil(message.summary.length / 4);
  }
  return estimateMessageTokens(message);
}

/**
 * 估算消息序列的上下文 token 数：优先取最后一条可用 assistant 消息的真实 usage 作基准
 * （aborted/error 及全零 usage 不算），其后的尾部消息用 estimateTokens 补齐；
 * 没有可用 usage 时逐条粗估。
 *
 * @param messages 消息序列。
 * @returns 估算的总上下文 token 数。
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message.role === "assistant" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "error" &&
      calculateContextTokens(message.usage) > 0
    ) {
      let trailingTokens = 0;
      for (let j = i + 1; j < messages.length; j++) {
        trailingTokens += estimateTokens(messages[j]);
      }
      return calculateContextTokens(message.usage) + trailingTokens;
    }
  }

  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message);
  }
  return total;
}

/**
 * 判断是否应触发压缩。
 *
 * @param contextTokens 当前上下文估算 token 数。
 * @param contextWindow 模型上下文窗口。
 * @param settings 压缩配置。
 * @returns 超过阈值（contextWindow - reserveTokens）时返回 true。
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** prepareCompaction 的产物：切点与待摘要消息。 */
export interface CompactionPreparation {
  /** 压缩后保留的第一条消息在原序列中的下标。 */
  firstKeptIndex: number;
  /** 将被摘要替代的消息（裁掉的前缀）。 */
  messagesToSummarize: AgentMessage[];
  /** 压缩前上下文估算 token 数。 */
  tokensBefore: number;
  /** 上一次压缩的摘要（队首已有 CompactionMessage 时），供迭代更新。 */
  previousSummary?: string;
}

/**
 * 找切点并收集待摘要消息。切点规则（对齐 pi findCutPoint）：
 * 从尾部向前累计估算 token，达到 keepRecentTokens 后把切点前移到最近的合法位置——
 * 绝不落在 toolResult 上（toolResult 必须跟随其 toolCall），从而保证
 * AssistantMessage.toolCalls 与其 ToolResultMessage 同进同出。
 *
 * @param messages 当前消息序列。
 * @param settings 压缩配置。
 * @returns 压缩准备产物；无需压缩（没有可裁前缀）时返回 undefined。
 */
export function prepareCompaction(
  messages: AgentMessage[],
  settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): CompactionPreparation | undefined {
  // 队首已有 CompactionMessage 时从其后面开始算边界，摘要可迭代更新。
  const hasPreviousCompaction = messages[0]?.role === "compaction";
  const boundaryStart = hasPreviousCompaction ? 1 : 0;
  if (boundaryStart >= messages.length) {
    return undefined;
  }

  let accumulatedTokens = 0;
  let cutIndex = boundaryStart;
  for (let i = messages.length - 1; i >= boundaryStart; i--) {
    accumulatedTokens += estimateTokens(messages[i]);
    if (accumulatedTokens >= settings.keepRecentTokens) {
      cutIndex = i;
      break;
    }
  }
  // 切点前移过 toolResult：保证 toolCalls 与其结果配对不被截断。
  while (cutIndex < messages.length && messages[cutIndex].role === "toolResult") {
    cutIndex += 1;
  }

  const messagesToSummarize = messages.slice(boundaryStart, cutIndex);
  if (messagesToSummarize.length === 0) {
    return undefined;
  }

  return {
    firstKeptIndex: cutIndex,
    messagesToSummarize,
    tokensBefore: estimateContextTokens(messages),
    previousSummary: hasPreviousCompaction ? (messages[0] as CompactionMessage).summary : undefined,
  };
}

/**
 * 纯函数压缩：把被裁前缀替换成一条 CompactionMessage 置于队首，保留后缀原样。
 *
 * @param messages 当前消息序列。
 * @param summary 被裁前缀的摘要文本（由调用方的 summarizer 产出）。
 * @param settings 压缩配置。
 * @returns 压缩后的消息序列；无需压缩时原样返回。
 */
export function compact(
  messages: AgentMessage[],
  summary: string,
  settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): AgentMessage[] {
  const preparation = prepareCompaction(messages, settings);
  if (!preparation) {
    return messages;
  }

  const compactionMessage: CompactionMessage = {
    role: "compaction",
    summary,
    tokensBefore: preparation.tokensBefore,
    summarizedMessageCount: preparation.messagesToSummarize.length,
    timestamp: Date.now(),
  };
  return [compactionMessage, ...messages.slice(preparation.firstKeptIndex)];
}

/** createCompactionTransform 的配置。 */
export interface CompactionTransformOptions {
  /**
   * 摘要器：对被裁前缀生成摘要文本；可基于 previousSummary 迭代更新。
   * 通常内部调一次 LLM（结构化摘要 prompt 见 pi SUMMARIZATION_PROMPT）。
   */
  summarizer: (messagesToSummarize: AgentMessage[], previousSummary: string | undefined, signal?: AbortSignal) => Promise<string>;
  /** 模型上下文窗口（与 model.contextWindow 二选一）。 */
  contextWindow?: number;
  /** 用其 contextWindow 的模型。 */
  model?: { contextWindow: number };
  /** 压缩配置覆盖。 */
  settings?: Partial<CompactionSettings>;
}

/**
 * 生成可直接挂到 AgentLoopConfig.transformContext 的自动阈值压缩变换：
 * 每次 LLM 调用前检查 shouldCompact，超阈值则调 summarizer 得到压缩后序列
 * （CompactionMessage 位于队首，由 convertToLlm 转成 user 消息）。
 *
 * 写回语义：压缩结果会**就地写回**传入的 messages 数组（splice 替换内容）。
 * loop 的 streamAssistantResponse 把 context.messages 原引用传给 transformContext，
 * 因此写回后 context.messages 同步被压缩——下一轮估算基于压缩后序列，不会每轮重复
 * 触发摘要，previousSummary 迭代更新也因此真正生效。调用方若传入的是副本，
 * 写回不影响其自有序列，但返回值仍是正确的压缩结果（语义等价）。
 *
 * @param options 压缩配置与摘要器。
 * @returns transformContext 钩子函数。
 */
export function createCompactionTransform(
  options: CompactionTransformOptions,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
  const contextWindow = options.contextWindow ?? options.model?.contextWindow;

  return async (messages, signal) => {
    if (!settings.enabled || !contextWindow) {
      return messages;
    }
    if (!shouldCompact(estimateContextTokens(messages), contextWindow, settings)) {
      return messages;
    }
    const preparation = prepareCompaction(messages, settings);
    if (!preparation) {
      return messages;
    }
    const summary = await options.summarizer(preparation.messagesToSummarize, preparation.previousSummary, signal);
    const compacted = compact(messages, summary, settings);
    // 就地写回：让持有同一数组引用的 context.messages 同步被压缩（见上方写回语义）。
    messages.splice(0, messages.length, ...compacted);
    return messages;
  };
}
