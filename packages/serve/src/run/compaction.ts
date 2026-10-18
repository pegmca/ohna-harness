/**
 * serve 侧的「run 前会话级 compaction」（L3-3）。
 *
 * 为什么压缩发生在 run 前：serve 的会话历史是 append-only JSONL，CLI 那种
 * 「run 结束后对全量 history 压缩并整文件重写」的落盘语义在这里不成立。
 * 因此 RunManager.createRun 在载入历史、追加本轮 prompt 之前执行压缩：
 * 摘要结果持久化为一条 `messageType:"compaction"` 的线性消息（role=user），
 * 后续 run 载入时经 `linearMessageToAgentMessage` 还原为 CompactionMessage，
 * 再由「丢弃最后一条 compaction 之前的所有消息」（dropBeforeLastCompaction）
 * 实现「摘要替换前缀」的 append-only 等价语义。
 *
 * 硬收敛（enforceContextWindow）只作用于本次 run 的内存历史：截断/丢弃的尾部
 * 消息仍留在磁盘上，下一次 run 会重新载入并再次压缩收敛——这是有意的取舍，
 * 保证磁盘消息线性完整（浏览器消息页可回放），代价是超大尾部每 run 重截一次。
 */
import {
  compact,
  enforceContextWindow,
  estimateContextTokens,
  estimateSequenceTokens,
  prepareCompaction,
  resolveCompactionSettings,
  shouldCompact,
  type AgentMessage,
  type CompactionMessage,
  type StreamFn,
} from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";
import type { Model } from "@aiagent/ai";

/** 会话级压缩结果。 */
export interface ServeCompactionResult {
  /** 压缩后的消息序列；未触发时为原序列。 */
  messages: AgentMessage[];
  /** 是否真正发生了压缩（含硬收敛）。 */
  compacted: boolean;
  /** 压缩前的双基准估算 token。 */
  tokensBefore: number;
  /** 压缩后的双基准估算 token。 */
  tokensAfter: number;
  /** 硬收敛截断 / 丢弃的消息条数（审计）。 */
  truncatedMessages: number;
  droppedMessages: number;
}

/** serve 摘要器配置。 */
export interface ServeSummarizerOptions {
  /** 当前模型（复用同一 provider / 凭据）。 */
  model: Model<"openai-completions">;
  /** provider 凭据。 */
  apiKey: string;
  /** 测试注入的流函数；与 RunManagerOptions.streamFn 同形。 */
  streamFn?: StreamFn;
  /** 摘要输出上限 token；缺省 1024。 */
  maxTokens?: number;
}

/** 摘要请求的系统提示词（与 CLI 语义一致；测试桩按该文案识别摘要调用）。 */
const SUMMARY_SYSTEM_PROMPT =
  "你是上下文压缩器。把给定的对话片段压缩成高信息密度的中文摘要，" +
  "保留：用户目标与约束、已确认的事实、已修改的文件与关键代码位置、执行过的命令与真实结果、未完成的下一步。" +
  "不要编造未出现的信息；不要输出客套话。";

/** 单条消息写入摘要 prompt 的字符上限，避免摘要请求自身超窗。 */
const PER_MESSAGE_CHARS = 2_000;
/** 摘要素材总字符上限（按窗口缩放，下限 4k、上限 24k）。 */
const MAX_TRANSCRIPT_CHARS_CAP = 24_000;

/**
 * 把单条 AgentMessage 渲染为摘要素材的一行文本。
 *
 * @param message 任意 AgentMessage。
 * @returns 单行可读文本（已截断）。
 */
function renderMessageForSummary(message: AgentMessage): string {
  const truncate = (text: string): string => (text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text);
  if (message.role === "compaction") return `[历史摘要] ${truncate(message.summary)}`;
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "[图片]")).join(" ");
    return `[user] ${truncate(text)}`;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "toolCall") parts.push(`[调用 ${block.name}] ${JSON.stringify(block.arguments)}`);
    }
    return `[assistant] ${truncate(parts.join("\n"))}`;
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : "[图片]"))
    .join(" ");
  return `[tool:${message.toolName}] ${truncate(text)}`;
}

/**
 * 创建 serve 侧 LLM 摘要器：失败时抛结构化错误，由调用方降级跳过压缩（不阻断 run）。
 *
 * @param options 模型、凭据与可选 streamFn。
 * @returns 摘要器函数（签名与 CLI SessionSummarizer 一致）。
 */
export function createServeSummarizer(options: ServeSummarizerOptions) {
  const transcriptLimit = Math.min(
    MAX_TRANSCRIPT_CHARS_CAP,
    Math.max(4_000, Math.floor(options.model.contextWindow * 1.5)),
  );
  const maxTokens = Math.min(options.maxTokens ?? 1_024, options.model.maxTokens);

  return async (
    messagesToSummarize: AgentMessage[],
    previousSummary?: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const transcript = messagesToSummarize
      .map(renderMessageForSummary)
      .reduce((lines, line) => {
        // 与 CLI buildSummaryTranscript 同语义：从最新往回收集，超出上限即止。
        if (lines.used + line.length > transcriptLimit) return lines;
        lines.used += line.length + 1;
        lines.items.unshift(line);
        return lines;
      }, { items: [] as string[], used: 0 })
      .items.join("\n");

    const promptParts = [
      previousSummary ? `已有摘要（请在其基础上迭代更新，不要丢失其中仍然有效的信息）：\n${previousSummary}` : "",
      "待压缩的对话片段：",
      transcript,
      "",
      "请输出更新后的摘要（纯文本，不要 markdown 代码块）。",
    ].filter(Boolean);

    // StreamFn 允许返回流或已 resolve 的流；先 await 统一再取 result。
    const stream = await (options.streamFn ?? streamSimple)(
      options.model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: promptParts.join("\n"), timestamp: Date.now() }],
      },
      { apiKey: options.apiKey, maxTokens, signal },
    );
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || `摘要调用失败（${message.stopReason}）`);
    }
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error("摘要模型返回空内容");
    return text;
  };
}

/**
 * append-only 载入语义：丢弃最后一条 compaction 消息之前的所有消息。
 *
 * 摘要消息在磁盘上位于序列末尾（append-only），但它代表「其之前全部历史」的压缩结果；
 * 取「最后一条」保证多次压缩时只用最新摘要，旧前缀与其对应的历史不再进入模型上下文。
 *
 * @param messages 已按 sequence 升序排列的消息。
 * @returns 以最后一条 CompactionMessage 开头（若存在）的消息序列。
 */
export function dropBeforeLastCompaction(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "compaction") {
      return messages.slice(index);
    }
  }
  return messages;
}

/** 会话级压缩的输入。 */
export interface CompactConversationOptions {
  /** 模型（取 contextWindow 决定阈值）。 */
  model: Model<"openai-completions">;
  /** 严格摘要器；失败时整体跳过压缩（run 照常进行）。 */
  summarizer?: (
    messagesToSummarize: AgentMessage[],
    previousSummary?: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** 失败告警回调。 */
  onWarn?: (message: string) => void;
}

/**
 * run 前的会话级压缩：双基准估算 → 超窗则摘要前缀 → 仍超窗则硬收敛。
 *
 * 失败语义：摘要抛错 / 无可摘要前缀时返回原序列（compacted:false），绝不阻断 run——
 * 压缩是治理优化；真正兜住「绝不超窗」最后一道的是下一次 run 前的重试与运行期 transformContext。
 *
 * @param messages 载入并过滤后的历史（可能已含 CompactionMessage）。
 * @param options 模型、摘要器与告警回调。
 * @returns 压缩结果与审计信息。
 */
export async function compactConversationHistory(
  messages: AgentMessage[],
  options: CompactConversationOptions,
): Promise<ServeCompactionResult> {
  const settings = resolveCompactionSettings(options.model.contextWindow);
  const tokensBefore = estimateSequenceTokens(messages);
  const base: ServeCompactionResult = {
    messages,
    compacted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    truncatedMessages: 0,
    droppedMessages: 0,
  };
  if (!shouldCompact(tokensBefore, options.model.contextWindow, settings)) return base;

  let working = messages;
  const preparation = prepareCompaction(messages, settings);
  if (preparation && options.summarizer) {
    try {
      const summary = await options.summarizer(preparation.messagesToSummarize, preparation.previousSummary);
      const compactedMessages = compact(messages, summary, settings);
      if (compactedMessages !== messages) working = compactedMessages;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onWarn?.(`run 前压缩摘要失败，本次 run 使用未压缩历史：${reason}`);
      return base;
    }
  }

  const enforced = enforceContextWindow(working, {
    contextWindow: options.model.contextWindow,
    reserveTokens: settings.reserveTokens,
  });
  const tokensAfter = estimateSequenceTokens(enforced.messages);
  if (tokensAfter >= tokensBefore) return { ...base, tokensAfter };
  return {
    messages: enforced.messages,
    compacted: true,
    tokensBefore,
    tokensAfter,
    truncatedMessages: enforced.truncatedMessages,
    droppedMessages: enforced.droppedMessages,
  };
}

/**
 * 从压缩后的内存历史提取需要持久化的 compaction 摘要。
 *
 * @param messages compactConversationHistory 的输出。
 * @returns 队首 CompactionMessage；不存在返回 undefined。
 */
export function extractCompactionSummary(messages: AgentMessage[]): CompactionMessage | undefined {
  const first = messages[0];
  return first && first.role === "compaction" ? first : undefined;
}
