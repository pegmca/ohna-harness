import {
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_RETRIEVAL_CANDIDATE_LIMIT,
  DEFAULT_RETRIEVAL_MODE,
  DEFAULT_VECTOR_WEIGHT,
  MAX_VECTOR_SEARCH_TOP_K,
  type EmbeddedChunk,
  type EmbeddingClient,
  type HybridRetrievalResult,
  type HybridRetrieverOptions,
  type RagStructuredError,
  type Reranker,
  type RerankResult,
  type RetrievalMode,
  type RetrievalOptions,
  type RetrievalTraceSummary,
  type RetrievedChunk,
  type Retriever,
  type VectorSearchMatch,
  type VectorSearchOptions,
  type VectorStore
} from "./types.js";
import { matchesVectorSearchFilter, normalizeTopK } from "./vector-math.js";

/**
 * 创建 deterministic heuristic reranker。
 *
 * 第一版 rerank 不接 LLM 或 cross-encoder，而是用 query term coverage、heading match 和 hybrid score
 * 做稳定排序；后续替换为模型 rerank 时只需实现同一个 Reranker 接口。
 *
 * @returns 可注入 Retriever 的 heuristic reranker。
 */
export function createHeuristicReranker(): Reranker {
  return new HeuristicReranker();
}

/**
 * 创建混合检索器。
 *
 * 关键词召回需要能扫描候选 chunk 文本，因此由调用方显式传入已索引 chunks；
 * 向量召回仍通过 VectorStore 完成，保持未来替换 Qdrant/pgvector 的边界清晰。
 *
 * @param options embedding client、vector store、关键词语料和可选 reranker。
 * @returns 支持 vector、keyword、hybrid 三种模式的检索器。
 */
export function createHybridRetriever(options: HybridRetrieverOptions): Retriever {
  return new HybridRetriever(options);
}

/**
 * 混合检索器实现，组合 query embedding、向量召回、关键词召回和可选 rerank。
 */
class HybridRetriever implements Retriever {
  private readonly embeddingClient: EmbeddingClient;
  private readonly vectorStore: VectorStore;
  private readonly chunks: readonly EmbeddedChunk[];
  private readonly reranker: Reranker;

  /**
   * 创建混合检索器实例。
   *
   * @param options 检索所需依赖和本地关键词语料。
   */
  public constructor(options: HybridRetrieverOptions) {
    this.embeddingClient = options.embeddingClient;
    this.vectorStore = options.vectorStore;
    this.chunks = options.chunks;
    this.reranker = options.reranker ?? createHeuristicReranker();
  }

  /**
   * 执行 vector、keyword 或 hybrid 检索，并返回可解释 score breakdown。
   *
   * @param query 用户查询。
   * @param options 检索模式、topK、候选数量、filter、权重和 rerank 开关。
   * @returns 成功时返回排序后的 chunks 和脱敏 trace；失败时返回结构化错误。
   */
  public async retrieve(query: string, options: RetrievalOptions = {}): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const normalizedOptions = normalizeRetrievalOptions(options);
    const queryPreview = createQueryPreview(query);

    if (!normalizedOptions.ok) {
      return {
        ok: false,
        error: normalizedOptions.error,
        trace: createRetrievalTraceSummary({
          queryPreview,
          mode: options.mode ?? DEFAULT_RETRIEVAL_MODE,
          topK: 0,
          candidateLimit: 0,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    if (query.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "retrieval_failed",
          message: "检索 query 不能为空。"
        },
        trace: createRetrievalTraceSummary({
          queryPreview,
          mode: normalizedOptions.mode,
          topK: normalizedOptions.topK,
          candidateLimit: normalizedOptions.candidateLimit,
          durationMs: Date.now() - startedAt,
          results: []
        })
      };
    }

    const queryTerms = tokenizeForRetrieval(query);
    const candidateMap = new Map<string, RetrievedChunk>();

    if (normalizedOptions.mode === "vector" || normalizedOptions.mode === "hybrid") {
      const vectorResult = await this.retrieveVectorCandidates(query, normalizedOptions);

      if (!vectorResult.ok) {
        return {
          ok: false,
          error: vectorResult.error,
          trace: createRetrievalTraceSummary({
            queryPreview,
            mode: normalizedOptions.mode,
            topK: normalizedOptions.topK,
            candidateLimit: normalizedOptions.candidateLimit,
            durationMs: Date.now() - startedAt,
            results: []
          })
        };
      }

      vectorResult.matches.forEach((match) => {
        candidateMap.set(
          match.chunk.chunkId,
          createRetrievedChunkDraft(match.chunk, {
            vectorScore: clampScore(match.score),
            keywordScore: 0,
            queryTerms,
            vectorWeight: normalizedOptions.vectorWeight,
            keywordWeight: normalizedOptions.keywordWeight
          })
        );
      });
    }

    if (normalizedOptions.mode === "keyword" || normalizedOptions.mode === "hybrid") {
      const keywordCandidates = retrieveKeywordCandidates(
        queryTerms,
        this.chunks,
        normalizedOptions.filter,
        normalizedOptions.candidateLimit
      );

      keywordCandidates.forEach((candidate) => {
        const existing = candidateMap.get(candidate.chunk.chunkId);
        const vectorScore = existing?.scoreBreakdown.vectorScore ?? 0;

        candidateMap.set(
          candidate.chunk.chunkId,
          createRetrievedChunkDraft(candidate.chunk, {
            vectorScore,
            keywordScore: candidate.keywordScore,
            queryTerms,
            vectorWeight: normalizedOptions.vectorWeight,
            keywordWeight: normalizedOptions.keywordWeight
          })
        );
      });
    }

    const mergedCandidates = [...candidateMap.values()]
      .sort(compareRetrievedChunks)
      .slice(0, normalizedOptions.candidateLimit)
      .map((result, index) => ({ ...result, rank: index + 1 }));

    const rerankedResult = normalizedOptions.rerank
      ? await this.reranker.rerank(query, mergedCandidates)
      : {
          ok: true as const,
          results: mergedCandidates.map((result, index) => ({ ...result, rank: index + 1 })),
          queryTerms
        };

    const topResults = rerankedResult.results.slice(0, normalizedOptions.topK).map((result, index) => ({
      ...result,
      rank: index + 1
    }));

    return {
      ok: true,
      results: topResults,
      trace: createRetrievalTraceSummary({
        queryPreview,
        mode: normalizedOptions.mode,
        topK: normalizedOptions.topK,
        candidateLimit: normalizedOptions.candidateLimit,
        durationMs: Date.now() - startedAt,
        results: topResults
      })
    };
  }

  /**
   * 查询向量库候选，并把 embedding 或 vector store 错误转换为 retrieval 边界错误。
   *
   * @param query 用户查询。
   * @param options 已规范化检索选项。
   * @returns 向量命中或结构化错误。
   */
  private async retrieveVectorCandidates(
    query: string,
    options: NormalizedRetrievalOptions
  ): Promise<{ ok: true; matches: VectorSearchMatch[] } | { ok: false; error: RagStructuredError }> {
    const embeddingResult = await this.embeddingClient.embedTexts([query]);

    if (!embeddingResult.ok) {
      return {
        ok: false,
        error: embeddingResult.error
      };
    }

    const vectorResult = await this.vectorStore.search(embeddingResult.embeddings[0].vector, {
      topK: options.candidateLimit,
      filter: options.filter
    });

    if (!vectorResult.ok) {
      return {
        ok: false,
        error: vectorResult.error
      };
    }

    return {
      ok: true,
      matches: vectorResult.matches
    };
  }
}

/**
 * heuristic reranker 实现，使用确定性规则提升更可引用的 chunk。
 */
class HeuristicReranker implements Reranker {
  /**
   * 对候选结果重新排序，并把 rerankScore 写入 score breakdown。
   *
   * @param query 用户查询。
   * @param results 待重排的召回候选。
   * @returns 重排后的候选列表。
   */
  public async rerank(query: string, results: readonly RetrievedChunk[]): Promise<RerankResult> {
    const queryTerms = tokenizeForRetrieval(query);
    const reranked = results
      .map((result) => {
        const matchedTerms = getMatchedTerms(queryTerms, result.chunk);
        const queryTermCoverage = calculateCoverage(queryTerms, matchedTerms);
        const headingMatch = doesHeadingMatch(queryTerms, result.chunk.heading);
        const rerankScore = clampScore(
          result.scoreBreakdown.hybridScore * 0.5 + queryTermCoverage * 0.35 + (headingMatch ? 0.15 : 0)
        );
        const finalScore = clampScore(result.scoreBreakdown.hybridScore * 0.7 + rerankScore * 0.3);

        return {
          ...result,
          score: finalScore,
          scoreBreakdown: {
            ...result.scoreBreakdown,
            matchedTerms,
            queryTermCoverage,
            headingMatch,
            rerankScore,
            finalScore
          }
        };
      })
      .sort(compareRetrievedChunks)
      .map((result, index) => ({
        ...result,
        rank: index + 1
      }));

    return {
      ok: true,
      results: reranked,
      queryTerms
    };
  }
}

interface NormalizedRetrievalOptions {
  mode: RetrievalMode;
  topK: number;
  candidateLimit: number;
  filter?: VectorSearchOptions["filter"];
  vectorWeight: number;
  keywordWeight: number;
  rerank: boolean;
}

interface KeywordCandidate {
  chunk: EmbeddedChunk;
  keywordScore: number;
}

/**
 * 校验并规范化检索选项。
 *
 * @param options 调用方传入的检索选项。
 * @returns 合法时返回补齐默认值的选项，否则返回结构化错误。
 */
function normalizeRetrievalOptions(
  options: RetrievalOptions
): { ok: true; mode: RetrievalMode; topK: number; candidateLimit: number; filter?: VectorSearchOptions["filter"]; vectorWeight: number; keywordWeight: number; rerank: boolean } | { ok: false; error: RagStructuredError } {
  if (
    options.filter?.documentIds !== undefined
    && (
      options.filter.documentIds.length === 0
      || options.filter.documentIds.length > 5
      || new Set(options.filter.documentIds).size !== options.filter.documentIds.length
      || options.filter.documentId !== undefined
    )
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_retrieval_options",
        message: "documentIds 必须包含 1 到 5 个不重复文档，且不能与 documentId 同时使用。"
      }
    };
  }
  const topKResult = normalizeTopK(options.topK);

  if (!topKResult.ok) {
    return topKResult;
  }

  const mode = options.mode ?? DEFAULT_RETRIEVAL_MODE;

  if (mode !== "vector" && mode !== "keyword" && mode !== "hybrid") {
    return {
      ok: false,
      error: {
        code: "invalid_retrieval_options",
        message: "检索模式必须是 vector、keyword 或 hybrid。",
        details: {
          mode
        }
      }
    };
  }

  const candidateLimit = options.candidateLimit ?? Math.max(DEFAULT_RETRIEVAL_CANDIDATE_LIMIT, topKResult.topK);

  if (!Number.isInteger(candidateLimit) || candidateLimit <= 0) {
    return {
      ok: false,
      error: {
        code: "invalid_retrieval_options",
        message: "candidateLimit 必须是大于 0 的整数。",
        details: {
          candidateLimit
        }
      }
    };
  }

  const vectorWeight =
    options.vectorWeight ?? (mode === "keyword" ? 0 : mode === "vector" ? 1 : DEFAULT_VECTOR_WEIGHT);
  const keywordWeight =
    options.keywordWeight ?? (mode === "vector" ? 0 : mode === "keyword" ? 1 : DEFAULT_KEYWORD_WEIGHT);

  if (vectorWeight < 0 || keywordWeight < 0 || vectorWeight + keywordWeight <= 0) {
    return {
      ok: false,
      error: {
        code: "invalid_retrieval_options",
        message: "vectorWeight 和 keywordWeight 必须为非负数，且总和大于 0。",
        details: {
          vectorWeight,
          keywordWeight
        }
      }
    };
  }

  return {
    ok: true,
    mode,
    topK: topKResult.topK,
    candidateLimit: Math.min(candidateLimit, MAX_VECTOR_SEARCH_TOP_K),
    filter: options.filter,
    vectorWeight,
    keywordWeight,
    rerank: options.rerank ?? true
  };
}

/**
 * 扫描本地 chunks 生成关键词候选。
 *
 * 第一版是轻量 BM25-like scoring：按 term frequency、覆盖率和 heading 命中加权，
 * 不引入重型索引依赖，适合学习阶段和小规模 demo。
 *
 * @param queryTerms 规范化后的查询词。
 * @param chunks 可扫描的 embedded chunks。
 * @param filter 可选 documentId/source 过滤。
 * @param candidateLimit 最大候选数。
 * @returns 关键词候选列表。
 */
function retrieveKeywordCandidates(
  queryTerms: readonly string[],
  chunks: readonly EmbeddedChunk[],
  filter: VectorSearchOptions["filter"],
  candidateLimit: number
): KeywordCandidate[] {
  return chunks
    .filter((chunk) => matchesVectorSearchFilter(chunk, filter))
    .map((chunk) => ({
      chunk,
      keywordScore: calculateKeywordScore(queryTerms, chunk)
    }))
    .filter((candidate) => candidate.keywordScore > 0)
    .sort((left, right) => {
      const scoreDelta = right.keywordScore - left.keywordScore;

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return compareChunkIdentity(left.chunk, right.chunk);
    })
    .slice(0, candidateLimit);
}

/**
 * 计算单个 chunk 的关键词分数。
 *
 * @param queryTerms 查询词。
 * @param chunk 候选 chunk。
 * @returns 0 到 1 之间的关键词分数。
 */
function calculateKeywordScore(queryTerms: readonly string[], chunk: EmbeddedChunk): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const contentTerms = tokenizeForRetrieval(`${chunk.heading ?? ""} ${chunk.text}`);
  const matchedTerms = getMatchedTerms(queryTerms, chunk);
  const coverage = calculateCoverage(queryTerms, matchedTerms);
  const frequencyScore = queryTerms.reduce((total, term) => total + countTerm(contentTerms, term), 0);
  const normalizedFrequency = frequencyScore / Math.max(contentTerms.length, 1);
  const headingBoost = doesHeadingMatch(queryTerms, chunk.heading) ? 0.18 : 0;

  return clampScore(coverage * 0.7 + Math.min(normalizedFrequency * 3, 0.12) + headingBoost);
}

/**
 * 创建带 score breakdown 的候选结果草稿。
 *
 * @param chunk 候选 chunk。
 * @param input 向量分、关键词分、查询词和权重。
 * @returns 可继续排序或 rerank 的 RetrievedChunk。
 */
function createRetrievedChunkDraft(
  chunk: EmbeddedChunk,
  input: {
    vectorScore: number;
    keywordScore: number;
    queryTerms: readonly string[];
    vectorWeight: number;
    keywordWeight: number;
  }
): RetrievedChunk {
  const weightTotal = input.vectorWeight + input.keywordWeight;
  const normalizedVectorWeight = input.vectorWeight / weightTotal;
  const normalizedKeywordWeight = input.keywordWeight / weightTotal;
  const matchedTerms = getMatchedTerms(input.queryTerms, chunk);
  const queryTermCoverage = calculateCoverage(input.queryTerms, matchedTerms);
  const headingMatch = doesHeadingMatch(input.queryTerms, chunk.heading);
  const hybridScore = clampScore(
    input.vectorScore * normalizedVectorWeight + input.keywordScore * normalizedKeywordWeight
  );

  return {
    chunk,
    rank: 0,
    score: hybridScore,
    scoreBreakdown: {
      vectorScore: input.vectorScore,
      keywordScore: input.keywordScore,
      hybridScore,
      finalScore: hybridScore,
      vectorWeight: normalizedVectorWeight,
      keywordWeight: normalizedKeywordWeight,
      matchedTerms,
      queryTermCoverage,
      headingMatch
    }
  };
}

/**
 * 比较两个检索候选，分数相同则按 chunkIndex 和 chunkId 稳定排序。
 *
 * @param left 左候选。
 * @param right 右候选。
 * @returns Array.sort 可用的比较值。
 */
function compareRetrievedChunks(left: RetrievedChunk, right: RetrievedChunk): number {
  const scoreDelta = right.score - left.score;

  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareChunkIdentity(left.chunk, right.chunk);
}

/**
 * 比较 chunk 身份，用于 deterministic tie-break。
 *
 * @param left 左 chunk。
 * @param right 右 chunk。
 * @returns Array.sort 可用的比较值。
 */
function compareChunkIdentity(left: EmbeddedChunk, right: EmbeddedChunk): number {
  if (left.chunkIndex !== right.chunkIndex) {
    return left.chunkIndex - right.chunkIndex;
  }

  return left.chunkId.localeCompare(right.chunkId);
}

/**
 * 生成不含完整敏感文档的 retrieval trace summary。
 *
 * @param input trace 所需的 query 摘要、选项、耗时和结果。
 * @returns 可写入 agent step 或返回给调用方的检索摘要。
 */
function createRetrievalTraceSummary(input: {
  queryPreview: string;
  mode: RetrievalMode;
  topK: number;
  candidateLimit: number;
  durationMs: number;
  results: readonly RetrievedChunk[];
}): RetrievalTraceSummary {
  return {
    queryPreview: input.queryPreview,
    mode: input.mode,
    topK: input.topK,
    candidateLimit: input.candidateLimit,
    durationMs: input.durationMs,
    chunkIds: input.results.map((result) => result.chunk.chunkId),
    scoreSummary: input.results.map((result) => ({
      chunkId: result.chunk.chunkId,
      documentId: result.chunk.documentId,
      vectorScore: result.scoreBreakdown.vectorScore,
      keywordScore: result.scoreBreakdown.keywordScore,
      hybridScore: result.scoreBreakdown.hybridScore,
      rerankScore: result.scoreBreakdown.rerankScore,
      finalScore: result.scoreBreakdown.finalScore,
      rank: result.rank
    }))
  };
}

/**
 * 为检索和 rerank 规范化 query/chunk 文本。
 *
 * 英文和数字按词切分，中文按连续词块与单字同时保留；这样既能匹配“净利润 ROE”，
 * 也能让“资产质量”这类中文短语获得可解释命中。
 *
 * @param text 输入文本。
 * @returns 去重后的检索 token。
 */
function tokenizeForRetrieval(text: string): string[] {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjkPhrases = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  const cjkChars = cjkPhrases.flatMap((phrase) => [...phrase]);
  const domainTerms = [
    "资产质量",
    "不良率",
    "拨备覆盖率",
    "净利润",
    "盈利能力",
    "现金流",
    "经营性现金流",
    "资本开支",
    "营收",
    "收入",
    "roe",
    "海外",
    "新能源"
  ].filter((term) => normalized.includes(term));

  return [...new Set([...words, ...cjkPhrases, ...domainTerms, ...cjkChars])];
}

/**
 * 计算查询词在 chunk 中实际命中的词。
 *
 * @param queryTerms 查询词。
 * @param chunk 候选 chunk。
 * @returns 命中的查询词列表。
 */
function getMatchedTerms(queryTerms: readonly string[], chunk: EmbeddedChunk): string[] {
  const contentTerms = tokenizeForRetrieval(`${chunk.heading ?? ""} ${chunk.text}`);
  const contentSet = new Set(contentTerms);

  return queryTerms.filter((term) => contentSet.has(term));
}

/**
 * 计算查询词覆盖率。
 *
 * @param queryTerms 查询词。
 * @param matchedTerms 命中的查询词。
 * @returns 0 到 1 的覆盖率。
 */
function calculateCoverage(queryTerms: readonly string[], matchedTerms: readonly string[]): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  return matchedTerms.length / queryTerms.length;
}

/**
 * 判断 heading 是否命中任意查询词。
 *
 * @param queryTerms 查询词。
 * @param heading 候选 chunk heading。
 * @returns 命中时返回 true。
 */
function doesHeadingMatch(queryTerms: readonly string[], heading: string | undefined): boolean {
  if (!heading) {
    return false;
  }

  const headingTerms = new Set(tokenizeForRetrieval(heading));

  return queryTerms.some((term) => headingTerms.has(term));
}

/**
 * 统计 term 在 token 数组中的出现次数。
 *
 * @param terms 候选 token。
 * @param target 目标 token。
 * @returns 出现次数。
 */
function countTerm(terms: readonly string[], target: string): number {
  return terms.reduce((count, term) => count + (term === target ? 1 : 0), 0);
}

/**
 * 将分数限制在 0 到 1，避免负向 cosine 或 boost 使解释分数越界。
 *
 * @param score 原始分数。
 * @returns 归一范围内的分数。
 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

/**
 * 生成 query 摘要，避免 trace 记录完整长查询或潜在敏感文本。
 *
 * @param query 原始查询。
 * @returns 最多 80 个字符的 query preview。
 */
export function createQueryPreview(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();

  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}
