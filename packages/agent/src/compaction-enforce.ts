/**
 * 压缩后的「硬收敛」：保证会话历史真正落到上下文窗口以下。
 *
 * 为什么需要这一层：内核 `compact` 只负责把前缀换成摘要，保留的最近消息仍可能单条就超窗
 * （例如一次 60KB 文件的 read 结果）。摘要压缩后若不重新校验，`compacted: true` 只是
 * 「执行过压缩」，并不等于「已经放得下」。本模块是共享纯函数（CLI 与 serve 两侧复用），
 * 不改内核 compact 语义：
 *   1. 先截断保留尾部中超大消息的文本内容（Assistant / ToolResult 的 text block，
 *      绝不改 toolCall arguments，保证工具调用仍可按原参数重放）；
 *   2. 仍超窗则从最旧的非 CompactionMessage 丢弃，并维持 Assistant toolCalls 与
 *      ToolResult 的配对；
 *   3. 截断 / 丢弃后用内容估算重新标定 assistant usage 锚点，避免旧 usage 让
 *      `estimateContextTokens` 永远停留在压缩前的数字。
 *
 * Phase 5 抽取说明：原实现位于 apps/ohna-cli/src/compaction-enforce.ts；serve 的
 * 「run 前会话级压缩」需要同一套硬收敛语义，为避免两侧实现漂移，将其下沉到
 * packages/agent（不改 agent-loop.ts），CLI 侧退化为 barrel re-export。
 */
import { calculateContextTokens } from "@aiagent/ai";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  type CompactionSettings,
} from "./compaction.js";
import type { AgentMessage } from "./types.js";

/** 截断标记：让模型和人都能看出该段内容不是原文。 */
export const TRUNCATION_MARKER = "\n…[已截断以适配上下文窗口]";

/** 单条消息至少保留的字符数；低于该值继续截断收益很小，不如走丢弃策略。 */
const MIN_MESSAGE_CHARS = 1_000;

/** 预留安全余量：估算本身是 chars/4 启发式，多截一点避免边界抖动。 */
const SAFETY_FACTOR = 1.1;

/**
 * 双基准估算：usage 锚点与逐条内容估算取最大。
 *
 * 运行期压缩后 assistant 的 usage 只反映 loop 副本（可能只有几百 token），
 * 而待落盘 history 仍含未压缩的大 ToolResult；只看 usage 会直接跳过截断，
 * 把超窗 JSONL 写进磁盘。这里统一改用双基准，保证硬收敛对准「真实内容」。
 *
 * @param messages 消息序列。
 * @returns usage 与内容估算的较大值。
 */
export function estimateSequenceTokens(messages: AgentMessage[]): number {
  const contentTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(estimateContextTokens(messages), contentTokens);
}

/**
 * 按模型上下文窗口缩放压缩阈值。
 *
 * 内核默认值（reserve 16384 / keepRecent 20000）面向 128k 模型；若用户用 env 配了 8k 小模型，
 * 默认值会出现「阈值 < 0 且保留量 > 窗口」的退化 —— 永远判定需要压缩、却切不出可摘要前缀。
 * 这里按窗口缩放：reserve ≤ 20% 窗口，keepRecent ≤ 40% 窗口；大窗口保持默认值不变。
 * 下限至少 1，避免极小窗口把阈值压成 0 后永远无法切分。
 *
 * @param contextWindow 模型上下文窗口（token）。
 * @returns 适配该窗口的压缩配置。
 */
export function resolveCompactionSettings(contextWindow: number): CompactionSettings {
  const keepRecentTokens = Math.max(
    1,
    Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(contextWindow * 0.4)),
  );
  const reserveTokens = Math.max(
    1,
    Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(contextWindow * 0.2)),
  );
  return { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens, reserveTokens };
}

/** 硬收敛选项。 */
export interface EnforceContextWindowOptions {
  /** 模型上下文窗口。 */
  contextWindow: number;
  /** 为下一次响应预留的 token 数。 */
  reserveTokens: number;
}

/** 硬收敛结果。 */
export interface EnforceContextWindowResult {
  /** 收敛后的消息序列（可能只含一条 CompactionMessage）。 */
  messages: AgentMessage[];
  /** 收敛后的上下文估算 token。 */
  tokensAfter: number;
  /** 被截断文本的消息条数。 */
  truncatedMessages: number;
  /** 被丢弃的消息条数。 */
  droppedMessages: number;
}

/**
 * 计算触发阈值：窗口减去预留量，至少保留 1 token，避免小窗口产生 0/负数阈值。
 *
 * @param options 窗口与预留量。
 * @returns 可用的最大 token 预算。
 */
function resolveThreshold(options: EnforceContextWindowOptions): number {
  return Math.max(1, options.contextWindow - options.reserveTokens);
}

/**
 * 把 assistant usage 锚点收敛到「截至该消息的内容估算」上限。
 *
 * 背景：`estimateContextTokens` 以最后一条 assistant 的真实 usage 为基准。文本被截断后
 * usage 仍是旧值，估算不会下降；这里把 totalTokens 压到内容估算的累计值，使估算反映
 * 截断后的真实上下文。cost 字段保持不变，会话成本仍以调用方的累计器为准。
 *
 * @param messages 当前消息序列。
 * @returns 可能替换了 assistant usage 的新序列。
 */
function clampUsageAnchors(messages: AgentMessage[]): AgentMessage[] {
  let cumulative = 0;
  return messages.map((message) => {
    cumulative += estimateTokens(message);
    if (message.role !== "assistant") return message;
    const original = calculateContextTokens(message.usage);
    if (cumulative <= 0 || original <= cumulative) return message;
    return {
      ...message,
      usage: { ...message.usage, totalTokens: cumulative },
    };
  });
}

/**
 * 判断消息是否含有可截断的文本块（仅 Assistant 与 ToolResult）。
 *
 * @param message 任意 AgentMessage。
 * @returns 有至少一个 text block 时返回 true。
 */
function hasTextBlock(message: AgentMessage): boolean {
  if (message.role !== "assistant" && message.role !== "toolResult") return false;
  // assistant / toolResult 的 content 是两种块数组类型的联合，方法回调无法推断，
  // 这里只需 type 字段，用最小结构视图访问。
  return (message.content as ReadonlyArray<{ type: string }>).some((block) => block.type === "text");
}

/**
 * 统计消息内 text block 的总字符数。
 *
 * @param message Assistant / ToolResult 消息。
 * @returns 文本字符数；其他角色返回 0。
 */
function textChars(message: AgentMessage): number {
  if (message.role !== "assistant" && message.role !== "toolResult") return 0;
  return message.content.reduce(
    (sum: number, block: { type: string; text?: string }) => sum + (block.type === "text" ? (block.text?.length ?? 0) : 0),
    0,
  );
}

/**
 * 截断一组内容块中的 text block，共享同一字符预算。
 *
 * 泛型保留调用方的内容块联合类型；只改写 text block，其它块（toolCall / image / thinking）原样返回。
 *
 * @template T 内容块类型（至少带 type 字段）。
 * @param content 内容块数组。
 * @param budget 该数组保留的字符预算。
 * @returns 新数组、移除字符数与是否发生变化。
 */
function truncateBlocks<T extends { type: string }>(
  content: T[],
  budget: number,
): { content: T[]; removedChars: number; changed: boolean } {
  let remaining = budget;
  let removedChars = 0;
  let changed = false;
  const next = content.map((block) => {
    if (block.type !== "text") return block;
    const text = (block as unknown as { text: string }).text;
    if (text.length <= remaining) {
      remaining -= text.length;
      return block;
    }
    const kept = remaining > 0 ? text.slice(0, remaining) : "";
    removedChars += text.length - kept.length;
    remaining = 0;
    changed = true;
    return { ...block, text: `${kept}${TRUNCATION_MARKER}` } as T;
  });
  return { content: next, removedChars, changed };
}

/**
 * 把单条消息的所有文本块截断到总预算内，并追加统一标记。
 *
 * 只动 text block：toolCall.arguments 必须保持原样，否则写类工具重放会改变副作用。
 *
 * @param message 待截断消息。
 * @param budget 该消息保留的字符预算。
 * @returns 截断后的消息与被移除的字符数；未变化时 message 为原引用。
 */
function truncateMessage(message: AgentMessage, budget: number): { message: AgentMessage; removedChars: number } {
  if (message.role === "assistant") {
    const result = truncateBlocks(message.content, budget);
    return result.changed
      ? { message: { ...message, content: result.content }, removedChars: result.removedChars }
      : { message, removedChars: 0 };
  }
  if (message.role === "toolResult") {
    const result = truncateBlocks(message.content, budget);
    return result.changed
      ? { message: { ...message, content: result.content }, removedChars: result.removedChars }
      : { message, removedChars: 0 };
  }
  return { message, removedChars: 0 };
}

/**
 * 执行硬收敛：先截断文本，再按「保留配对」规则从最旧消息丢弃，直到低于阈值。
 *
 * @param messages 已（可能）压过前缀的消息序列。
 * @param options 窗口与预留量。
 * @returns 收敛结果与审计计数。
 */
export function enforceContextWindow(
  messages: AgentMessage[],
  options: EnforceContextWindowOptions,
): EnforceContextWindowResult {
  const threshold = resolveThreshold(options);
  let working = [...messages];
  let truncatedMessages = 0;
  let droppedMessages = 0;

  const beforeTruncate = estimateSequenceTokens(working);
  if (beforeTruncate > threshold) {
    const candidates = working.filter(hasTextBlock);
    const totalChars = candidates.reduce((sum, message) => sum + textChars(message), 0);
    const overflowChars = Math.max(0, (beforeTruncate - threshold) * 4 * SAFETY_FACTOR);
    if (candidates.length > 0 && totalChars > 0) {
      const targetChars = totalChars - overflowChars;
      const perMessageBudget = Math.max(MIN_MESSAGE_CHARS, Math.floor(targetChars / candidates.length));
      working = working.map((message) => {
        if (!hasTextBlock(message) || textChars(message) <= perMessageBudget) return message;
        const truncated = truncateMessage(message, perMessageBudget);
        if (truncated.removedChars > 0) truncatedMessages += 1;
        return truncated.message;
      });
      // 只有确实发生了内容截断才重标 usage，否则不修改历史数字。
      if (truncatedMessages > 0) working = clampUsageAnchors(working);
    }
  }

  // 仍超窗：从最旧的非 CompactionMessage 开始丢，保持 toolCall / toolResult 同进同出。
  while (estimateSequenceTokens(working) > threshold) {
    const index = working.findIndex((message) => message.role !== "compaction");
    if (index < 0) break;

    const [removed] = working.splice(index, 1);
    droppedMessages += 1;
    if (removed.role === "assistant") {
      // content 是多 api 联合块数组，直接对联合数组回调推断会退化成 any，
      // 这里用最小结构视图只提取 toolCall 的 id（工具调用配对丢弃所需的全部信息）。
      const toolCallIds = new Set(
        (removed.content as ReadonlyArray<{ type: string; id?: string }>)
          .filter((block) => block.type === "toolCall" && typeof block.id === "string")
          .map((block) => block.id as string),
      );
      if (toolCallIds.size > 0) {
        const beforePairedDrop = working.length;
        working = working.filter(
          (message) => !(message.role === "toolResult" && toolCallIds.has(message.toolCallId)),
        );
        // 配对删除也计入审计，避免日志显示「只丢了 1 条」却少了两条。
        droppedMessages += beforePairedDrop - working.length;
      }
    }
    // 丢弃后累计内容变小，重新标定 usage 锚点，估算才会真实下降。
    working = clampUsageAnchors(working);
  }

  return {
    messages: working,
    tokensAfter: estimateSequenceTokens(working),
    truncatedMessages,
    droppedMessages,
  };
}
