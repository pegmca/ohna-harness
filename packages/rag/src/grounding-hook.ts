import type { AgentMessage } from "@aiagent/agent";
import type { RetrievalTraceDto } from "@aiagent/types";
import { assembleUntrustedContext, type UntrustedContent } from "@aiagent/security";
import { createRetrievalResultFromRetrievedChunk } from "./answer.js";
import { createTraceRetrievalEvent } from "./source-uri.js";
import type { Citation, RetrievalResult, Retriever } from "./types.js";

/** 附件 grounding 默认召回数量，与旧 run-service 保持一致。 */
const DEFAULT_ATTACHMENT_GROUNDING_TOP_K = 5;

/**
 * grounding hook 构造选项。
 *
 * 设计依据 docs/worktree/06-capability-integration.md 第 1 节：
 * 附件与检索结果以 data-only user 消息形式注入 agent loop，经 <untrusted_context> 安全封装。
 *
 * v1.1 改造：附件源不再是 DataSourceRuntime（那会检索主库、无法表达"会话级临时附件"），
 * 而是按会话绑定的 attachmentRetriever（AttachmentStore 之上的 Retriever）。
 */
export interface GroundingHookOptions {
  /** 会话级附件检索入口；已按 conversationId 绑定，只检索本会话附件。 */
  attachmentRetriever: Retriever;
  /** 本次 run 的会话 id；用于显式声明 scope 与观测（检索器本身已按会话绑定）。 */
  conversationId: string;
  /** 本次 run 的附件 documentId 快照；为空时不注入任何 grounding。 */
  attachmentDocumentIds: readonly string[];
  /**
   * 当前调用身份。附件检索已由 attachmentRetriever 按会话绑定，本字段不再参与检索，
   * 保留用于 run 层作用域标注与观测（与旧签名保持兼容，避免调用方无谓改动）。
   */
  ownerUserId: string;
  /** topK，默认 5。 */
  topK?: number;
  /** 检索事件写入 run_events 的回调；事件名保持 "retrieval"。 */
  recordRetrieval?: (event: RetrievalTraceDto) => void | Promise<void>;
}

/**
 * grounding transformContext：可直接挂到 AgentLoopConfig.transformContext 的函数，
 * 额外暴露 getCitationsForTurn 供 run 层按“用户消息时间戳”关联 assistant 消息与 citation。
 */
export interface GroundingTransformContext {
  (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  /**
   * 按用户消息时间戳取该轮 grounding 注入的 citation 快照。
   * 时间戳由 agent loop 消息本身携带，避免 event stream 异步消费导致的 race。
   *
   * @param userMessageTimestamp 本轮最后一条用户消息的时间戳。
   * @returns 去重后的 citation 列表；无记录时返回空数组。
   */
  getCitationsForTurn(userMessageTimestamp: number): Citation[];
}

/**
 * 创建 transformContext hook：每轮模型调用前按附件 documentIds 检索相关片段，
 * 经 prompt injection 评估后封装为 <untrusted_context> UserMessage 注入上下文。
 *
 * 注入去重：按 chunk id 记忆已注入内容，只在首轮或有新片段时追加消息，
 * 避免 pi transformContext 每轮都跑导致的重复注入。
 *
 * 由于 event stream 消费与 assistant 生成是并发的，不能把 citation 存在单变量里。
 * 这里按“本轮最后一条用户消息的时间戳”分槽保存，run 层在 message_end 时按时间戳取用。
 *
 * @param options hook 选项。
 * @returns 可直接传给 agentLoop config.transformContext 的函数。
 */
export function createGroundingTransformContext(options: GroundingHookOptions): GroundingTransformContext {
  const topK = options.topK ?? DEFAULT_ATTACHMENT_GROUNDING_TOP_K;
  const injectedChunkIds = new Set<string>();
  const citationsByUserTimestamp = new Map<number, Citation[]>();

  const transform = async (messages: AgentMessage[], _signal?: AbortSignal): Promise<AgentMessage[]> => {
    const documentIds = options.attachmentDocumentIds;
    if (documentIds.length === 0) return messages;

    const { query, timestamp: userTimestamp } = extractLastUserQuery(messages);
    // 只有该时间戳首次出现时才占位，避免多轮复用同一条用户消息时覆盖已保存的 citation。
    if (!citationsByUserTimestamp.has(userTimestamp)) {
      citationsByUserTimestamp.set(userTimestamp, []);
    }

    if (!query.trim()) return messages;

    // 附件检索：AttachmentStore 已按会话隔离，这里只需给出 topK，无需再传 documentIds 过滤。
    const retrievalResult = await options.attachmentRetriever.retrieve(query, { topK });
    const traceEvent = createTraceRetrievalEvent(query, retrievalResult);

    if (!retrievalResult.ok) {
      if (options.recordRetrieval) {
        await options.recordRetrieval(traceEvent);
      }
      return messages;
    }

    const newResults = retrievalResult.results
      .map(createRetrievalResultFromRetrievedChunk)
      .filter((item) => !injectedChunkIds.has(item.chunkId));
    if (newResults.length === 0) return messages;

    if (options.recordRetrieval) {
      await options.recordRetrieval(traceEvent);
    }

    newResults.forEach((item) => injectedChunkIds.add(item.chunkId));
    const latestCitations = newResults.map((item) => item.citation);
    const existingCitations = citationsByUserTimestamp.get(userTimestamp) ?? [];
    const existingIds = new Set(existingCitations.map((citation) => citation.chunkId));
    citationsByUserTimestamp.set(
      userTimestamp,
      [...existingCitations, ...latestCitations.filter((citation) => !existingIds.has(citation.chunkId))]
    );

    const untrustedItems: UntrustedContent[] = newResults.map((item, index) => ({
      id: item.chunkId,
      source: "external_document",
      content: formatChunkForModel(item, index + 1),
    }));

    const contextMessage = assembleUntrustedContext(untrustedItems);
    const groundedMessage: AgentMessage = {
      role: "user",
      content: contextMessage.content,
      timestamp: Date.now(),
    };

    return insertBeforeLastUserMessage(messages, groundedMessage);
  };

  transform.getCitationsForTurn = (userMessageTimestamp: number): Citation[] =>
    citationsByUserTimestamp.get(userMessageTimestamp) ?? [];
  return transform;
}

/**
 * 从消息序列提取最后一条用户消息的纯文本与时间戳，作为附件检索 query 和 citation 分槽键。
 *
 * @param messages 当前上下文。
 * @returns query 与对应用户消息时间戳；无用户消息时 query 为空串。
 */
function extractLastUserQuery(messages: readonly AgentMessage[]): { query: string; timestamp: number } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
    const query = typeof content === "string"
      ? content
      : content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("");
    return { query, timestamp: message.timestamp };
  }
  return { query: "", timestamp: Date.now() };
}

/**
 * 在最后一个用户消息之前插入 grounding 上下文，使模型先看到证据再看到问题。
 * 若上下文中没有用户消息，则追加到末尾。
 *
 * @param messages 原消息序列。
 * @param inject 待注入的 grounding user 消息。
 * @returns 新消息序列。
 */
function insertBeforeLastUserMessage(messages: readonly AgentMessage[], inject: AgentMessage): AgentMessage[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      index = i;
      break;
    }
  }
  if (index === -1) return [...messages, inject];
  return [...messages.slice(0, index), inject, ...messages.slice(index)];
}

/**
 * 把检索结果格式化为带引用序号的文本块，便于模型在回答中直接引用 [1]、[2]。
 *
 * @param result 检索结果。
 * @param ordinal 展示序号。
 * @returns 模型可见文本。
 */
function formatChunkForModel(result: RetrievalResult, ordinal: number): string {
  const heading = result.citation.heading ? `${result.citation.heading} / ` : "";
  return `[${ordinal}] 来源：${heading}${result.citation.source}\n${result.text}`;
}
