/**
 * 会话级长任务治理：LLM 摘要器 + compaction 编排。
 *
 * 为什么需要「会话级」压缩：`agentLoop` 在进入 run 时复制上下文（`agent-loop.ts:126`），
 * `transformContext` 的压缩结果只存在于 loop 内部副本，`agent_end.messages` 只含本轮增量。
 * 因此调用方保存的 history 永远未压缩——必须由组合根在 run 结束后对全量 history
 * 再跑一次 shouldCompact/compact，把 `CompactionMessage` + 未压缩尾部写回会话文件。
 * 好处：内核零改动。代价：运行期摘要结果无法取回，落盘时可能对同一段历史二次摘要
 * （见下方双基准说明与 `` 的取舍记录）。
 *
 * 与 `packages/agent` 的分工：压缩原语（估算/切点/纯函数 compact）在内核包；
 * 本模块只负责「摘要怎么来」与「失败如何降级」这两个 CLI 侧策略。
 */
import {
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  resolveCompactionSettings,
  enforceContextWindow,
  type AgentMessage,
} from "@aiagent/agent";
import { streamSimple, type Model, type Usage } from "@aiagent/ai";

/** 预算/时限停止原因：三者都在 `shouldStopAfterTurn` 里判定。 */
export type RunStopReason = "max_turns" | "deadline" | "max_cost";

/** 停止原因 → 中文提示。 */
export const RUN_STOP_REASON_TEXT: Record<RunStopReason, string> = {
  max_turns: "达到最大回合数",
  deadline: "达到截止时间",
  max_cost: "达到成本预算",
};

/** 可变的停止原因槽：由 config 闭包写入，runTurn 在 agent_end 后读取并打印。 */
export interface RunStopState {
  reason?: RunStopReason;
}

/**
 * 按模型上下文窗口缩放压缩阈值（`resolveCompactionSettings` 已下沉到 `@aiagent/agent`，
 * 此处 re-export 保持既有导入路径与单测兼容；实现说明见 packages/agent/src/compaction-enforce.ts）。
 */
export { resolveCompactionSettings } from "@aiagent/agent";

/** 摘要器签名（与 CompactionTransformOptions.summarizer 一致）。 */
export type SessionSummarizer = (
  messagesToSummarize: AgentMessage[],
  previousSummary?: string,
  signal?: AbortSignal,
) => Promise<string>;

/** LLM 摘要器配置。 */
export interface LlmSummarizerOptions {
  /** 当前生效模型（复用同一 provider / 凭据）。 */
  model: Model<"openai-completions">;
  /** provider 凭据。 */
  apiKey: string;
  /** 摘要输出上限，默认 1024 token。 */
  maxTokens?: number;
  /** 送进摘要 prompt 的原始文本上限（字符），避免摘要请求本身超窗。 */
  maxTranscriptChars?: number;
  /**
   * 摘要调用的 usage 回调。摘要消息本身不进入 history，但 token / cost 必须计入会话，
   * 否则 `/cost`、session header usage 与 `--max-cost` 会漏掉这部分真实开销。
   */
  onUsage?: (usage: Usage) => void;
  /** 可注入的流式函数（默认 streamSimple；单测用它返回带 usage 的桩响应）。 */
  streamFn?: typeof streamSimple;
}

/** 摘要调用失败时的兜底文案长度。 */
const FALLBACK_SUMMARY_CHARS = 4_000;

/** 单条消息写入摘要 prompt 的字符上限。 */
const PER_MESSAGE_CHARS = 2_000;

/** 摘要请求的系统提示词。 */
const SUMMARY_SYSTEM_PROMPT =
  "你是上下文压缩器。把给定的对话片段压缩成高信息密度的中文摘要，" +
  "保留：用户目标与约束、已确认的事实、已修改的文件与关键代码位置、执行过的命令与真实结果、未完成的下一步。" +
  "不要编造未出现的信息；不要输出客套话。";

/**
 * 把单条 AgentMessage 渲染成摘要素材文本。
 *
 * @param message 任意 AgentMessage（含 CompactionMessage）。
 * @returns 一行可读文本（内部已截断）。
 */
function renderMessageForSummary(message: AgentMessage): string {
  if (message.role === "compaction") {
    return `[历史摘要] ${truncate(message.summary, PER_MESSAGE_CHARS)}`;
  }
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "[图片]")).join(" ");
    return `[user] ${truncate(text, PER_MESSAGE_CHARS)}`;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "toolCall") parts.push(`[调用 ${block.name}] ${JSON.stringify(block.arguments)}`);
    }
    return `[assistant] ${truncate(parts.join("\n"), PER_MESSAGE_CHARS)}`;
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : "[图片]"))
    .join(" ");
  return `[tool:${message.toolName}] ${truncate(text, PER_MESSAGE_CHARS)}`;
}

/**
 * 拼接待摘要消息的纯文本素材。
 *
 * @param messages 待摘要消息。
 * @param maxChars 总字符上限（超出时保留更靠后的消息，因为靠近当前的上下文更相关）。
 * @returns 摘要素材文本。
 */
export function buildSummaryTranscript(messages: AgentMessage[], maxChars: number): string {
  const rendered = messages.map(renderMessageForSummary);
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const line = rendered[i];
    if (used + line.length > maxChars) {
      // 单条消息本身就超预算时截断它（保留开头），保证摘要 prompt 始终有上限。
      if (kept.length === 0) kept.unshift(truncate(line, maxChars));
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/**
 * 确定性兜底摘要：LLM 摘要不可用时，保留最近消息的截断文本，确保压缩后仍有信息可用。
 *
 * @param messages 待摘要消息。
 * @param reason 失败原因（写入摘要头部，便于审计）。
 * @returns 兜底摘要文本。
 */
export function buildFallbackSummary(messages: AgentMessage[], reason: string): string {
  const transcript = buildSummaryTranscript(messages, FALLBACK_SUMMARY_CHARS);
  return `[自动兜底摘要] 摘要模型不可用（${reason}）。以下为原始片段，可能不完整：\n${transcript}`;
}

/**
 * 创建 LLM 摘要器：复用当前模型与凭据调用一次 `streamSimple`。
 *
 * 失败时**抛出结构化错误**，由调用方决定「运行期用兜底摘要」「会话保存放弃压缩」。
 * 不在这里吞错，是为了让会话级保存能遵守「压缩失败保存未压缩版本」的语义。
 *
 * @param options 模型、凭据与输出上限。
 * @returns 摘要器函数。
 */
export function createLlmSummarizer(options: LlmSummarizerOptions): SessionSummarizer {
  // 摘要请求本身也要能塞进模型窗口：小窗口模型按比例收缩素材与输出上限。
  const transcriptLimit =
    options.maxTranscriptChars ??
    Math.min(24_000, Math.max(4_000, Math.floor(options.model.contextWindow * 1.5)));
  const maxTokens = Math.min(options.maxTokens ?? 1_024, options.model.maxTokens);

  return async (messagesToSummarize, previousSummary, signal) => {
    const transcript = buildSummaryTranscript(messagesToSummarize, transcriptLimit);
    const promptParts = [
      previousSummary ? `已有摘要（请在其基础上迭代更新，不要丢失其中仍然有效的信息）：\n${previousSummary}` : "",
      "待压缩的对话片段：",
      transcript,
      "",
      "请输出更新后的摘要（纯文本，不要 markdown 代码块）。",
    ].filter(Boolean);

    const stream = (options.streamFn ?? streamSimple)(
      options.model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: promptParts.join("\n"), timestamp: Date.now() }],
      },
      { apiKey: options.apiKey, maxTokens, signal },
    );
    const message = await stream.result();
    // 先计费再判错：provider 可能返回错误但仍带 usage（例如部分网关按请求计费）。
    options.onUsage?.(message.usage);
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
 * 给摘要器套一层兜底：异常时返回确定性摘要并告警。
 * 运行期 transformContext 用这个包装，避免摘要失败直接把正在进行的 run 打断。
 *
 * @param summarizer 真实摘要器。
 * @param onWarn 告警回调（CLI 注入 stderr 输出）。
 * @returns 永不 reject 的摘要器。
 */
export function withSummaryFallback(
  summarizer: SessionSummarizer,
  onWarn?: (message: string) => void,
): SessionSummarizer {
  return async (messagesToSummarize, previousSummary, signal) => {
    try {
      return await summarizer(messagesToSummarize, previousSummary, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onWarn?.(`运行期压缩摘要失败，已使用兜底摘要：${reason}`);
      return buildFallbackSummary(messagesToSummarize, reason);
    }
  };
}

/** 会话级压缩结果。 */
export interface SessionCompactionResult {
  /** 压缩后的消息序列；未触发或失败时为原序列。 */
  messages: AgentMessage[];
  /** 是否真正发生了压缩（以 tokensAfter < tokensBefore 为准）。 */
  compacted: boolean;
  /** 压缩前上下文估算 token（usage 锚点与逐条内容估算取最大）。 */
  tokensBefore: number;
  /** 压缩后上下文估算 token（同一双基准；未触发时等于 tokensBefore）。 */
  tokensAfter: number;
  /** 压缩前消息条数。 */
  messageCountBefore: number;
  /** 硬收敛阶段被截断文本的消息条数。 */
  truncatedMessages: number;
  /** 硬收敛阶段被丢弃的消息条数。 */
  droppedMessages: number;
}

/** 会话级压缩选项。 */
export interface SessionCompactionOptions {
  /** 当前模型（取 contextWindow）。 */
  model: { contextWindow: number };
  /** 严格摘要器；失败时整体放弃压缩。 */
  summarizer: SessionSummarizer;
  /** 失败告警。 */
  onWarn?: (message: string) => void;
}

/**
 * 内容层面 token 估算：逐条 chars/4 求和，不依赖 assistant usage 锚点。
 *
 * 为什么需要第二个基准：`estimateContextTokens` 以最后一条 assistant 的真实 usage 为准，
 * 而运行期压缩后那次调用的 usage 很小（模型只看到摘要 + 尾部），会把整段历史误判为「很小」。
 * 落盘时若只看 usage，会漏掉未压缩的大 ToolResult，导致 JSONL 仍超窗、`--resume` 直接失败。
 *
 * @param messages 消息序列。
 * @returns 内容层面估算 token 数。
 */
function estimateContentTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * 会话级压缩：run 结束后对全量 history 检查阈值，触发时摘要前缀并做硬收敛。
 *
 * 双基准（D1）：`tokensBefore = max(usage 锚点估算, 逐条内容估算)`。运行期压缩后 assistant
 * 的 usage 只反映压缩后的 loop 副本，单看 usage 会把 26k token 的历史误判为 110 token；
 * 取两者最大值才能保证「落盘的历史真的放得下」。tokensAfter 同样用双基准，只有内容层面
 * 也确实下降才返回 `compacted: true`。
 *
 * 失败语义：摘要抛错时打印告警并返回未压缩序列（`compacted: false`），
 * 由调用方照常保存——「压缩是优化，不是保存的前置条件」。
 *
 * 成功语义：只有 `tokensAfter < tokensBefore` 才算压缩成功。摘要后仍超窗时执行
 * `enforceContextWindow`（截断文本 → 丢弃最旧消息），确保写回的历史真正低于阈值。
 *
 * @param messages 当前全量 history。
 * @param options 模型、摘要器与告警回调。
 * @returns 压缩结果（含审计用的 token / 条数）。
 */
export async function compactSessionHistory(
  messages: AgentMessage[],
  options: SessionCompactionOptions,
): Promise<SessionCompactionResult> {
  // 两个基准取最大：usage 可能高估（真实 provider 计费口径）或低估（压缩后的小 usage）。
  const tokensBefore = Math.max(estimateContextTokens(messages), estimateContentTokens(messages));
  const base: SessionCompactionResult = {
    messages,
    compacted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    messageCountBefore: messages.length,
    truncatedMessages: 0,
    droppedMessages: 0,
  };

  const settings = resolveCompactionSettings(options.model.contextWindow);
  if (!shouldCompact(tokensBefore, options.model.contextWindow, settings)) return base;

  let working = messages;
  const preparation = prepareCompaction(messages, settings);
  if (preparation) {
    try {
      const summary = await options.summarizer(
        preparation.messagesToSummarize,
        preparation.previousSummary,
      );
      const compactedMessages = compact(messages, summary, settings);
      if (compactedMessages !== messages) working = compactedMessages;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.onWarn?.(`会话压缩失败，已保存未压缩版本：${reason}`);
      return base;
    }
  }

  // 摘要后（或没有可摘要前缀时）重新估算，仍超窗就硬收敛到阈值以下。
  // 硬收敛内部同样使用双基准，避免「usage 很小但内容仍很大」时跳过截断。
  const enforced = enforceContextWindow(working, {
    contextWindow: options.model.contextWindow,
    reserveTokens: settings.reserveTokens,
  });
  const tokensAfter = Math.max(
    estimateContextTokens(enforced.messages),
    estimateContentTokens(enforced.messages),
  );
  if (tokensAfter >= tokensBefore) {
    return { ...base, tokensAfter };
  }
  return {
    ...base,
    messages: enforced.messages,
    compacted: true,
    tokensAfter,
    truncatedMessages: enforced.truncatedMessages,
    droppedMessages: enforced.droppedMessages,
  };
}

/**
 * 过滤失败/中断的 assistant 消息：provider error 与用户 Ctrl-C 产生的空 assistant
 * 不应进入会话历史，否则下次恢复会把一条无效的“助手回复”重新发给模型。
 *
 * 只删 assistant，保留其前置 user 消息；顺序不变。
 *
 * @param messages 待落盘 / 合并的消息序列。
 * @returns 过滤后的新序列。
 */
export function filterFailedAssistants(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted")
      ),
  );
}

/**
 * 单行文本截断（保留尾部更重要的信息时由调用方控制顺序）。
 *
 * @param text 原始文本。
 * @param max 最大字符数。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
