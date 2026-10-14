import type { AttachmentStore } from "./attachment-store.js";
import { createQueryPreview } from "./retrieval.js";
import type {
  EmbeddingClient,
  HybridRetrievalResult,
  RetrievalOptions,
  RetrievalTraceSummary,
  RetrievedChunk,
  Retriever,
  VectorSearchMatch
} from "./types.js";

/** 附件检索默认召回数量，与 grounding 默认 topK 对齐。 */
const DEFAULT_ATTACHMENT_RETRIEVAL_TOP_K = 5;

/**
 * 附件检索器构造选项。
 */
export interface AttachmentRetrieverOptions {
  /** embedding provider 边界。 */
  embeddingClient: EmbeddingClient;
  /** 会话级附件存储。 */
  attachmentStore: AttachmentStore;
  /** 会话 id；检索被限制在该会话的附件桶内。 */
  conversationId: string;
  /** 默认 topK；调用方可在 retrieve 时按 options.topK 覆盖。 */
  topK?: number;
}

/**
 * 创建会话级附件检索器。
 *
 * 单源附件检索（P1）：query → embedding → AttachmentStore.search(conversationId, vector, topK)。
 * 只做向量召回，不做关键词召回与 rerank（多路合并 + rerank 属 P2）；但返回类型仍是
 * HybridRetrievalResult，让 grounding 与 trace 链路无需为附件单独开分支。
 *
 * @param options embedding client、附件存储、会话 id 与默认 topK。
 * @returns 绑定单一会话的 Retriever。
 */
export function createAttachmentRetriever(options: AttachmentRetrieverOptions): Retriever {
  return new AttachmentRetriever(options);
}

/**
 * 附件检索器实现：把会话附件桶包装成与主 RAG 同形的 Retriever。
 */
class AttachmentRetriever implements Retriever {
  private readonly embeddingClient: EmbeddingClient;
  private readonly attachmentStore: AttachmentStore;
  private readonly conversationId: string;
  private readonly topK: number | undefined;

  /**
   * 创建附件检索器实例。
   *
   * @param options 检索所需依赖与默认 topK。
   */
  public constructor(options: AttachmentRetrieverOptions) {
    this.embeddingClient = options.embeddingClient;
    this.attachmentStore = options.attachmentStore;
    this.conversationId = options.conversationId;
    this.topK = options.topK;
  }

  /**
   * 执行附件向量检索，并返回可解释 score breakdown 与 trace。
   *
   * topK 解析顺序：调用方 options.topK → 构造时 topK → 默认 5。
   * scoreBreakdown 只填向量分量（vectorWeight=1、keywordWeight=0），因为 P1 附件检索是纯向量；
   * 这样下游 formatChunkForModel / citation 无需感知来源差异。
   *
   * @param query 用户查询。
   * @param options 检索选项；仅使用 topK。
   * @returns 成功时返回排序后的 chunks 与 trace；embed/search 失败时返回结构化错误与空 trace。
   */
  public async retrieve(query: string, options: RetrievalOptions = {}): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const topK = options.topK ?? this.topK ?? DEFAULT_ATTACHMENT_RETRIEVAL_TOP_K;
    const queryPreview = createQueryPreview(query);

    const embeddingResult = await this.embeddingClient.embedTexts([query]);

    if (!embeddingResult.ok) {
      return {
        ok: false,
        error: embeddingResult.error,
        trace: createAttachmentTraceSummary({
          queryPreview,
          topK,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    const searchResult = await this.attachmentStore.search(
      this.conversationId,
      embeddingResult.embeddings[0].vector,
      topK
    );

    if (!searchResult.ok) {
      return {
        ok: false,
        error: searchResult.error,
        trace: createAttachmentTraceSummary({
          queryPreview,
          topK,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    const results = searchResult.matches.map(createRetrievedChunkFromMatch);

    return {
      ok: true,
      results,
      trace: createAttachmentTraceSummary({
        queryPreview,
        topK,
        durationMs: Date.now() - startedAt,
        results
      })
    };
  }
}

/**
 * 把附件向量命中映射为统一的 RetrievedChunk，scoreBreakdown 只填向量分量。
 *
 * @param match AttachmentStore.search 返回的命中。
 * @returns 带 vector-only score breakdown 的检索候选。
 */
function createRetrievedChunkFromMatch(match: VectorSearchMatch): RetrievedChunk {
  const score = match.score;

  return {
    chunk: match.chunk,
    rank: match.rank,
    score,
    scoreBreakdown: {
      vectorScore: score,
      keywordScore: 0,
      hybridScore: score,
      finalScore: score,
      vectorWeight: 1,
      keywordWeight: 0,
      matchedTerms: [],
      queryTermCoverage: 0,
      headingMatch: false
    }
  };
}

/**
 * 生成附件检索 trace 摘要，mode 固定为 vector。
 *
 * candidateLimit 取 topK（附件检索没有独立的候选池）；失败分支传空 results，
 * 保证 retrieval 事件始终可写入 run_events。
 *
 * @param input query 摘要、topK、耗时与结果。
 * @returns 可写入 run_events 的检索摘要。
 */
function createAttachmentTraceSummary(input: {
  queryPreview: string;
  topK: number;
  durationMs: number;
  results: readonly RetrievedChunk[];
}): RetrievalTraceSummary {
  return {
    queryPreview: input.queryPreview,
    mode: "vector",
    topK: input.topK,
    candidateLimit: input.topK,
    durationMs: input.durationMs,
    chunkIds: input.results.map((result) => result.chunk.chunkId),
    scoreSummary: input.results.map((result) => ({
      chunkId: result.chunk.chunkId,
      vectorScore: result.scoreBreakdown.vectorScore,
      keywordScore: result.scoreBreakdown.keywordScore,
      hybridScore: result.scoreBreakdown.hybridScore,
      finalScore: result.scoreBreakdown.finalScore,
      rank: result.rank
    }))
  };
}
