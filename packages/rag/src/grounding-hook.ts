import type { AgentMessage } from "@aiagent/agent";
import type { RetrievalTraceDto } from "@aiagent/types";
import { assembleUntrustedContext, type UntrustedContent } from "@aiagent/security";
import { createRetrievalResultFromRetrievedChunk } from "./answer.js";
import { createTraceRetrievalEvent } from "./source-uri.js";
import type { InlineAttachment } from "./attachment-store.js";
import type {
  Citation,
  CitationSourceKind,
  EmbeddedChunk,
  RetrievalResult,
  RetrievedChunk,
  Retriever
} from "./types.js";

/** 附件 grounding 默认召回数量，与旧 run-service 保持一致。 */
const DEFAULT_ATTACHMENT_GROUNDING_TOP_K = 5;

/**
 * grounding hook 构造选项（P2 多路签名，见 docs/v1.1/06-chat-attachments.md §8.2）。
 *
 * 设计依据 docs/worktree/06-capability-integration.md 第 1 节：
 * 附件与检索结果以 data-only user 消息形式注入 agent loop，经 <untrusted_context> 安全封装。
 *
 * P2 改造：从"仅附件检索器 + documentIds 门禁"改为"多路检索器 + 内联附件"：
 * - retriever 由组合根用 createMultiSourceRetriever（附件索引路 + 内部库路）构造；
 * - inlineAttachments 是 ≤阈值的小附件原文，直接合成 score=1 的候选注入，不经检索；
 * - 两者皆空时不注入（门禁）。
 */
export interface GroundingHookOptions {
  /** 多路检索编排（附件索引路 + 内部库路）；无 leg 时传 undefined。 */
  retriever?: Retriever;
  /** 本会话需内联注入的小附件（≤阈值）；run 层按 attachmentDocumentIds 解析后传入。 */
  inlineAttachments?: readonly InlineAttachment[];
  /** 本次 run 的会话 id；用于观测与作用域标注（检索器本身已按会话绑定）。 */
  conversationId: string;
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
 * 创建 transformContext hook：每轮模型调用前做多路检索 + 内联合成，
 * 经 prompt injection 评估后封装为 <untrusted_context> UserMessage 注入上下文。
 *
 * 注入去重：按 chunk id 记忆已注入内容，只在首轮或有新片段时追加消息，
 * 避免 pi transformContext 每轮都跑导致的重复注入；内联附件优先于检索结果。
 *
 * 由于 event stream 消费与 assistant 生成是并发的，不能把 citation 存在单变量里。
 * 这里按“本轮最后一条用户消息的时间戳”分槽保存，run 层在 message_end 时按时间戳取用。
 *
 * @param options hook 选项（多路检索器、内联附件、会话 id、topK、trace 回调）。
 * @returns 可直接传给 agentLoop config.transformContext 的函数。
 */
export function createGroundingTransformContext(options: GroundingHookOptions): GroundingTransformContext {
  const topK = options.topK ?? DEFAULT_ATTACHMENT_GROUNDING_TOP_K;
  const inlineAttachments = options.inlineAttachments ?? [];
  const injectedChunkIds = new Set<string>();
  const citationsByUserTimestamp = new Map<number, Citation[]>();

  const transform = async (messages: AgentMessage[], _signal?: AbortSignal): Promise<AgentMessage[]> => {
    // 门禁：既无检索腿又无内联附件时，原样返回，不注入任何 grounding。
    if (!options.retriever && inlineAttachments.length === 0) return messages;

    const { query, timestamp: userTimestamp } = extractLastUserQuery(messages);
    // 只有该时间戳首次出现时才占位，避免多轮复用同一条用户消息时覆盖已保存的 citation。
    if (!citationsByUserTimestamp.has(userTimestamp)) {
      citationsByUserTimestamp.set(userTimestamp, []);
    }

    if (!query.trim()) return messages;

    // 检索腿为 best-effort：失败不阻断内联附件注入，但仍记录失败 trace 供观测。
    let retrievalResults: RetrievedChunk[] = [];
    let traceEvent: RetrievalTraceDto | undefined;

    if (options.retriever) {
      const retrievalResult = await options.retriever.retrieve(query, { topK });
      traceEvent = createTraceRetrievalEvent(query, retrievalResult);
      if (retrievalResult.ok) {
        retrievalResults = retrievalResult.results;
      }
    }

    // 内联附件的合成候选排在前，检索结果在后；按 chunkId 去重（先到者胜）。
    const inlineResults = inlineAttachments.map(createInlineRetrievedChunk);
    const candidates = dedupeByChunkId([...inlineResults, ...retrievalResults]);
    const newResults = candidates
      .filter((result) => !injectedChunkIds.has(result.chunk.chunkId))
      .map(createRetrievalResultFromRetrievedChunk);

    if (newResults.length === 0) {
      // 无新内容：仅在检索腿失败时记录失败 trace，便于观测"附件接地仍可用但内部库不可用"。
      if (traceEvent && !traceEvent.ok && options.recordRetrieval) {
        await options.recordRetrieval(traceEvent);
      }
      return messages;
    }

    if (traceEvent && options.recordRetrieval) {
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
 * 把内联附件合成为 score=1 的检索候选。
 *
 * chunkId 取 documentId（uuid），与向量索引 chunk 的 `${docId}_chunk_0000` 分属两个命名空间，
 * 不会碰撞；embedding 为空数组、embeddingModel 用稳定占位常量，仅用于满足 EmbeddedChunk 形状，
 * 不参与任何向量计算（内联不走检索）。source 用 fileName 以便 citation 展示可读来源。
 *
 * @param attachment 内联附件。
 * @returns 可直接注入的 RetrievedChunk（sourceKind=attachment）。
 */
function createInlineRetrievedChunk(attachment: InlineAttachment): RetrievedChunk {
  const chunk: EmbeddedChunk = {
    chunkId: attachment.documentId,
    id: attachment.documentId,
    documentId: attachment.documentId,
    source: attachment.fileName,
    chunkIndex: 0,
    text: attachment.text,
    charStart: 0,
    charEnd: attachment.text.length,
    startOffset: 0,
    endOffset: attachment.text.length,
    metadata: {},
    embedding: [],
    embeddingModel: "inline-attachment"
  };

  return {
    chunk,
    rank: 0,
    score: 1,
    scoreBreakdown: {
      vectorScore: 0,
      keywordScore: 0,
      hybridScore: 1,
      finalScore: 1,
      vectorWeight: 0,
      keywordWeight: 0,
      matchedTerms: [],
      queryTermCoverage: 0,
      headingMatch: false
    },
    sourceKind: "attachment"
  };
}

/**
 * 按 chunkId 对候选去重，先出现者保留。
 *
 * 内联合成候选排在检索结果之前，因此同 id 时内联优先；
 * 正常情况下两者命名空间不重叠，此去重主要用于防御性一致。
 *
 * @param results 合并后的候选列表。
 * @returns 去重后的候选列表。
 */
function dedupeByChunkId(results: readonly RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const deduped: RetrievedChunk[] = [];

  results.forEach((result) => {
    if (seen.has(result.chunk.chunkId)) {
      return;
    }

    seen.add(result.chunk.chunkId);
    deduped.push(result);
  });

  return deduped;
}

/**
 * 从消息序列提取最后一条用户消息的纯文本与时间戳，作为检索 query 和 citation 分槽键。
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
 * 把检索结果格式化为带引用序号和来源标签的文本块，便于模型在回答中直接引用 [1]、[2]。
 *
 * 格式：`[n] 来源：{label} · {heading} / {source}`，缺省片段干净省略：
 * - 有 label + heading：`附件 · 概述 / note.md`；
 * - 仅 label：`附件 / note.md`；仅 heading：`概述 / note.md`；都没有：`note.md`。
 *
 * @param result 检索结果。
 * @param ordinal 展示序号。
 * @returns 模型可见文本。
 */
function formatChunkForModel(result: RetrievalResult, ordinal: number): string {
  const label = sourceKindLabel(result.citation.sourceKind);
  const heading = result.citation.heading ?? "";
  const head = [label, heading].filter((segment) => segment.length > 0).join(" · ");
  const prefix = head.length > 0 ? `${head} / ` : "";

  return `[${ordinal}] 来源：${prefix}${result.citation.source}\n${result.text}`;
}

/**
 * 把来源类型映射为模型可见的中文标签。
 *
 * @param sourceKind 引用来源类型；缺省表示来源未知。
 * @returns 附件 / 内部知识库；未知来源返回空串（不显示标签）。
 */
function sourceKindLabel(sourceKind: CitationSourceKind | undefined): string {
  if (sourceKind === "attachment") {
    return "附件";
  }

  if (sourceKind === "internal") {
    return "内部知识库";
  }

  return "";
}
