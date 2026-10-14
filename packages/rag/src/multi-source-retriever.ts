import { createHeuristicReranker, createQueryPreview } from "./retrieval.js";
import {
  DEFAULT_RETRIEVAL_CANDIDATE_LIMIT,
  DEFAULT_VECTOR_SEARCH_TOP_K,
  type CitationSourceKind,
  type HybridRetrievalResult,
  type RagStructuredError,
  type RetrievalOptions,
  type RetrievalTraceSummary,
  type RetrievedChunk,
  type Retriever,
  type Reranker
} from "./types.js";

/**
 * 多路召回中的一条检索腿。
 *
 * 设计依据 docs/v1.1/06-chat-attachments.md §8.2（D-P2-1）：
 * 附件路与内部库路各自召回 top-k，再合并去重、统一精排一次。
 * sourceKind 在合并时打到每条候选上，供 citation / trace / prompt 标注来源。
 */
export interface RetrievalLeg {
  /** 该路来源：attachment（会话级临时附件）或 internal（内部知识库）。 */
  sourceKind: CitationSourceKind;
  /** 该路检索器（附件路由 createAttachmentRetriever 构造，内部库路由 DataSourceRuntime.retriever 构造）。 */
  retriever: Retriever;
  /** 该路候选上限；缺省取编排器的 candidateLimit。 */
  topK?: number;
}

/**
 * 多路召回编排器构造选项。
 */
export interface MultiSourceRetrieverOptions {
  /** 检索腿列表；顺序即优先级（同一 chunkId 先到者胜）。 */
  legs: readonly RetrievalLeg[];
  /** 合并后的精排器；缺省 createHeuristicReranker()。 */
  reranker?: Reranker;
  /** 最终返回条数；缺省 DEFAULT_VECTOR_SEARCH_TOP_K。 */
  topK?: number;
  /** 各路候选池上限；缺省 max(DEFAULT_RETRIEVAL_CANDIDATE_LIMIT, topK)。 */
  candidateLimit?: number;
}

/**
 * 创建多路召回编排器。
 *
 * 语义（必须可预测，见 §8.2）：
 * 1. 每条 leg 调 `retriever.retrieve(query, { topK: leg.topK ?? candidateLimit, candidateLimit, rerank: false })`，
 *    拿到"未精排候选"（附件路忽略 rerank/candidateLimit，hybrid 路返回未精排候选）。
 * 2. **best-effort**：某 leg 失败则跳过；≥1 路成功即继续；全失败才返回 ok:false（取首个错误）。
 *    这样"内部库腿异常"不会拖垮"附件接地"。
 * 3. 合并：`Map<chunkId, RetrievedChunk>`，leg 顺序即优先级（同 chunkId 先到者胜），并打上 sourceKind。
 * 4. 对合并集统一精排一次，再截 topK 并重排 rank——避免各路双重 rerank。
 *
 * @param options 检索腿、精排器与 topK/candidateLimit。
 * @returns 可注入 grounding/run 层的 Retriever。
 */
export function createMultiSourceRetriever(options: MultiSourceRetrieverOptions): Retriever {
  return new MultiSourceRetriever(options);
}

/**
 * 多路召回编排器实现。
 */
class MultiSourceRetriever implements Retriever {
  private readonly legs: readonly RetrievalLeg[];
  private readonly reranker: Reranker;
  private readonly topK: number;
  private readonly candidateLimit: number;

  /**
   * 创建编排器实例。
   *
   * @param options 检索腿、精排器与 topK/candidateLimit。
   */
  public constructor(options: MultiSourceRetrieverOptions) {
    this.legs = options.legs;
    this.reranker = options.reranker ?? createHeuristicReranker();
    this.topK = options.topK ?? DEFAULT_VECTOR_SEARCH_TOP_K;
    this.candidateLimit = options.candidateLimit ?? Math.max(DEFAULT_RETRIEVAL_CANDIDATE_LIMIT, this.topK);
  }

  /**
   * 执行多路召回合并：逐路召回 → 合并去重 → 统一精排 → 截断。
   *
   * @param query 用户查询。
   * @param options 调用方可在 retrieve 时覆盖 topK / candidateLimit。
   * @returns 成功时返回合并后的候选与 hybrid trace；全部 leg 失败时返回结构化错误与空 trace。
   */
  public async retrieve(query: string, options: RetrievalOptions = {}): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const queryPreview = createQueryPreview(query);
    const topK = options.topK ?? this.topK;
    const candidateLimit = options.candidateLimit ?? this.candidateLimit;

    // 无 leg：返回成功空结果（不抛错），让"仅内联附件"的会话也能复用同一 Retriever 契约。
    if (this.legs.length === 0) {
      return {
        ok: true,
        results: [],
        trace: createMultiSourceTraceSummary({
          queryPreview,
          topK,
          candidateLimit,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    const merged = new Map<string, RetrievedChunk>();
    let succeededLegs = 0;
    let firstError: RagStructuredError | undefined;

    for (const leg of this.legs) {
      const legResult = await this.retrieveLegSafely(leg, query, candidateLimit);

      if (!legResult.ok) {
        // best-effort：记录首个错误继续，其它 leg 仍可贡献候选。
        if (firstError === undefined) {
          firstError = legResult.error;
        }
        continue;
      }

      succeededLegs += 1;
      legResult.results.forEach((result) => {
        if (merged.has(result.chunk.chunkId)) {
          return;
        }
        // 合并去重 + 来源标注：leg 顺序即优先级，先到者保留并打上其 sourceKind。
        merged.set(result.chunk.chunkId, { ...result, sourceKind: leg.sourceKind });
      });
    }

    if (succeededLegs === 0) {
      return {
        ok: false,
        error: firstError ?? {
          code: "retrieval_failed",
          message: "多路检索全部失败。"
        },
        trace: createMultiSourceTraceSummary({
          queryPreview,
          topK,
          candidateLimit,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    const mergedCandidates = [...merged.values()];
    const reranked = await this.reranker.rerank(query, mergedCandidates);
    const topResults = reranked.results.slice(0, topK).map((result, index) => ({
      ...result,
      rank: index + 1
    }));

    return {
      ok: true,
      results: topResults,
      trace: createMultiSourceTraceSummary({
        queryPreview,
        topK,
        candidateLimit,
        durationMs: Date.now() - startedAt,
        results: topResults
      })
    };
  }

  /**
   * 安全执行单条 leg：把异常与结构化错误统一收敛为 `{ ok:false, error }`，供 best-effort 合并。
   *
   * @param leg 待执行检索腿。
   * @param query 用户查询。
   * @param candidateLimit 候选池上限。
   * @returns 该路候选或结构化错误。
   */
  private async retrieveLegSafely(
    leg: RetrievalLeg,
    query: string,
    candidateLimit: number
  ): Promise<{ ok: true; results: RetrievedChunk[] } | { ok: false; error: RagStructuredError }> {
    try {
      const legResult = await leg.retriever.retrieve(query, {
        topK: leg.topK ?? candidateLimit,
        candidateLimit,
        rerank: false
      });

      if (!legResult.ok) {
        return { ok: false, error: legResult.error };
      }

      return { ok: true, results: legResult.results };
    } catch {
      return {
        ok: false,
        error: {
          code: "retrieval_failed",
          message: `检索腿（${leg.sourceKind}）执行异常。`,
          details: { sourceKind: leg.sourceKind }
        }
      };
    }
  }
}

/**
 * 生成多路召回的 trace 摘要，mode 固定 hybrid 并标注每条候选的 sourceKind。
 *
 * retrieval.ts 的 createRetrievalTraceSummary 是模块私有，故此处写本地 builder；
 * 失败分支传空 results，保证 retrieval 事件始终可写入 run_events。
 *
 * @param input query 摘要、topK、candidateLimit、耗时与结果。
 * @returns 可写入 run_events 的检索摘要。
 */
function createMultiSourceTraceSummary(input: {
  queryPreview: string;
  topK: number;
  candidateLimit: number;
  durationMs: number;
  results: readonly RetrievedChunk[];
}): RetrievalTraceSummary {
  return {
    queryPreview: input.queryPreview,
    mode: "hybrid",
    topK: input.topK,
    candidateLimit: input.candidateLimit,
    durationMs: input.durationMs,
    chunkIds: input.results.map((result) => result.chunk.chunkId),
    scoreSummary: input.results.map((result) => ({
      chunkId: result.chunk.chunkId,
      vectorScore: result.scoreBreakdown.vectorScore,
      keywordScore: result.scoreBreakdown.keywordScore,
      hybridScore: result.scoreBreakdown.hybridScore,
      rerankScore: result.scoreBreakdown.rerankScore,
      finalScore: result.scoreBreakdown.finalScore,
      rank: result.rank,
      ...(result.sourceKind !== undefined ? { sourceKind: result.sourceKind } : {})
    }))
  };
}
