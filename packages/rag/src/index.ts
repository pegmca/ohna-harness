import { detectFilingFileType, ingestFiling } from "@aiagent/filings";
import { createHash } from "node:crypto";
import type {
  CitationDto,
  DataSourceDocumentDto,
  DataSourceIngestRequestDto,
  DataSourceIngestResponseDto,
  EmbeddedChunkDto,
  EmbeddingUsageDto,
  IngestedFilingDocumentDto,
  IngestedTextBlockDto,
  RagAnswerDto,
  RagChunkDto,
  RagDocumentDto,
  RetrievalResultDto,
  RetrievalScoreBreakdownDto,
  TraceRetrievalEventDto,
  VectorSearchMatchDto
} from "@aiagent/types";
import {
  createInMemoryRagDocumentRepository,
  validateRagOwnerScope,
  type NewRagChunkRecord,
  type RagChunkRecord,
  type RagDocumentRepository,
  type RagDocumentScope,
  type RagDocumentSourceType,
  type SaveRagIngestionInput,
  type SaveRagIngestionResult
} from "./document-repository.js";

export {
  assertValidOwnerScope,
  createInMemoryRagDocumentRepository,
  createPersistentChunkId,
  isRagDocumentVisible,
  RagOwnerScopeValidationError,
  validateRagOwnerScope
} from "./document-repository.js";
export type {
  ListRagChunksQuery,
  ListRagDocumentsQuery,
  NewRagChunkRecord,
  RagChunkRecord,
  RagDocumentRecord,
  RagDocumentRepository,
  RagDocumentScope,
  RagDocumentSourceType,
  RagDocumentSummary,
  RagDocumentVersionRecord,
  RagDocumentVersionStatus,
  RagIngestionOutcome,
  SaveRagIngestionInput,
  SaveRagIngestionResult
} from "./document-repository.js";

export type RagDocument = RagDocumentDto;
export type RagChunk = RagChunkDto;
export type Citation = CitationDto;
export type RetrievalResult = RetrievalResultDto;
export type RetrievalScoreBreakdown = RetrievalScoreBreakdownDto;
export type RagAnswer = RagAnswerDto;
export type EmbeddedChunk = EmbeddedChunkDto;
export type EmbeddingUsage = EmbeddingUsageDto;
export type VectorSearchMatch = VectorSearchMatchDto;

export type EmbeddingVector = readonly number[];

export type ChunkingStrategy = "fixed_size" | "heading_aware";

export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxChars: number;
  overlapChars: number;
}

/**
 * 单条 embedding 输出，保留原文、序号和模型名，便于调用方把向量映射回 chunk。
 */
export interface EmbeddingItem {
  text: string;
  vector: EmbeddingVector;
  index: number;
  model: string;
}

/**
 * embedding 批量结果使用 ok/error union，避免 provider 或 mock 校验失败时向上抛原始异常。
 */
export type EmbeddingResult =
  | {
      ok: true;
      embeddings: EmbeddingItem[];
      usage: EmbeddingUsage;
      dimensions: number;
      model: string;
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

/**
 * EmbeddingClient 是真实 provider 和 mock provider 的替换边界，调用方只依赖文本到向量的稳定合同。
 */
export interface EmbeddingClient {
  embedTexts(texts: readonly string[]): Promise<EmbeddingResult>;
}

/**
 * deterministic mock embedding 的配置，允许单测显式固定模型名和维度。
 */
export interface DeterministicMockEmbeddingClientOptions {
  model: string;
  dimensions: number;
}

/**
 * 向量检索选项控制召回数量和 metadata 过滤，第一版只支持文档和来源两个稳定条件。
 */
export interface VectorSearchOptions {
  topK?: number;
  filter?: {
    documentId?: string;
    source?: string;
  };
}

/**
 * 向量库写入结果记录 upsert 数量和替换数量，用于验证索引状态而不暴露内部 Map。
 */
export type VectorStoreResult =
  | {
      ok: true;
      upsertedCount: number;
      replacedCount: number;
      totalCount: number;
      dimensions: number;
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

/**
 * 向量检索结果统一返回有序 matches；空索引是成功空数组，只有参数或维度错误才返回失败。
 */
export type VectorSearchResult =
  | {
      ok: true;
      matches: VectorSearchMatch[];
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

/**
 * VectorStore 是内存实现和未来 Qdrant/pgvector 实现的替换边界。
 */
export interface VectorStore {
  upsertChunks(chunks: readonly EmbeddedChunk[]): Promise<VectorStoreResult>;
  search(queryVector: EmbeddingVector, options?: VectorSearchOptions): Promise<VectorSearchResult>;
}

export type RetrievalMode = "vector" | "keyword" | "hybrid";

export interface RetrievalOptions {
  mode?: RetrievalMode;
  topK?: number;
  candidateLimit?: number;
  filter?: VectorSearchOptions["filter"];
  vectorWeight?: number;
  keywordWeight?: number;
  rerank?: boolean;
}

export interface RetrievedChunk {
  chunk: EmbeddedChunk;
  rank: number;
  score: number;
  scoreBreakdown: RetrievalScoreBreakdown;
}

export interface RerankResult {
  ok: true;
  results: RetrievedChunk[];
  queryTerms: string[];
}

export interface Reranker {
  rerank(query: string, results: readonly RetrievedChunk[]): Promise<RerankResult>;
}

export interface RetrievalTraceSummary {
  queryPreview: string;
  mode: RetrievalMode;
  topK: number;
  candidateLimit: number;
  durationMs: number;
  chunkIds: string[];
  scoreSummary: {
    chunkId: string;
    vectorScore: number;
    keywordScore: number;
    hybridScore: number;
    rerankScore?: number;
    finalScore: number;
    rank: number;
  }[];
}

export type HybridRetrievalResult =
  | {
      ok: true;
      results: RetrievedChunk[];
      trace: RetrievalTraceSummary;
    }
  | {
      ok: false;
      error: RagStructuredError;
      trace: RetrievalTraceSummary;
    };

export interface Retriever {
  retrieve(query: string, options?: RetrievalOptions): Promise<HybridRetrievalResult>;
}

export type DataSourceRuntimeResult<TData> =
  | {
      ok: true;
      data: TData;
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

export interface RagSearchRuntimeResponse {
  results: RetrievalResult[];
  trace: TraceRetrievalEventDto;
}

export interface RagAnswerRuntimeResponse {
  answer: RagAnswer;
  trace: TraceRetrievalEventDto;
}

/**
 * ingestion 调用上下文：owner 与 scope 由 API adapter 从身份 session 推导，
 * 缺省 ownerUserId 为空时落 shared scope，保持匿名 demo 行为向后兼容。
 */
export interface DataSourceIngestContext {
  ownerUserId?: string | null;
  scope?: RagDocumentScope;
}

/** 文档/chunk 分页查询选项，ownerUserId 缺省为匿名（只见 shared/demo）。 */
export interface DataSourceListOptions {
  ownerUserId?: string | null;
  cursor?: string;
  limit?: number;
}

/** chunk 分页查询选项，可按 documentId 过滤。 */
export interface DataSourceListChunksOptions extends DataSourceListOptions {
  documentId?: string;
}

/**
 * DataSourceRuntime 封装 ingestion lineage 持久化、chunk、embedding、内存向量索引、retrieval 和 answer policy。
 *
 * 文档/版本/chunk 事实源是 RagDocumentRepository（PostgreSQL 或内存 adapter）；
 * VectorStore 仍是进程内实现，只服务当前进程的 search/answer。
 */
export interface DataSourceRuntime {
  ingest(
    request: DataSourceIngestRequestDto,
    context?: DataSourceIngestContext
  ): Promise<DataSourceRuntimeResult<DataSourceIngestResponseDto>>;
  listDocuments(options?: DataSourceListOptions): Promise<{ documents: DataSourceDocumentDto[]; nextCursor: string | null }>;
  listChunks(options?: DataSourceListChunksOptions): Promise<{ chunks: RagChunk[]; nextCursor: string | null }>;
  search(query: string, options?: RetrievalOptions): Promise<DataSourceRuntimeResult<RagSearchRuntimeResponse>>;
  answer(question: string, options?: RetrievalOptions): Promise<DataSourceRuntimeResult<RagAnswerRuntimeResponse>>;
}

export interface HybridRetrieverOptions {
  embeddingClient: EmbeddingClient;
  vectorStore: VectorStore;
  chunks: readonly EmbeddedChunk[];
  reranker?: Reranker;
}

export interface RagStructuredError {
  code:
    | "invalid_chunking_options"
    | "chunking_failed"
    | "invalid_embedding_input"
    | "embedding_failed"
    | "embedding_dimension_mismatch"
    | "invalid_vector_search_options"
    | "vector_store_dimension_mismatch"
    | "invalid_retrieval_options"
    | "retrieval_failed"
    | "ingestion_failed"
    | "indexing_failed"
    | "answer_failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface ChunkTextInput {
  documentId: string;
  source: string;
  text: string;
  heading?: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ChunkBlocksInput {
  documentId: string;
  source: string;
  blocks: readonly IngestedTextBlockDto[];
}

export type ChunkingResult =
  | {
      ok: true;
      chunks: RagChunk[];
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

export interface RagPackageSummary {
  packageName: "@aiagent/rag";
  boundary: "chunking_embedding_retrieval_citation_answer";
  runtimeState: "hybrid_retrieval_ready";
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  strategy: "heading_aware",
  maxChars: 1200,
  overlapChars: 150
};

/** 解析器版本标识：写入 document_versions，便于后续重放与兼容性诊断。 */
export const RAG_PARSER_VERSION = "filings-markdown-txt-v1";

/** 切块器版本标识：由默认 chunking options 派生，策略或窗口变化时必须同步更新。 */
export const RAG_CHUNKER_VERSION = `${DEFAULT_CHUNKING_OPTIONS.strategy}-${DEFAULT_CHUNKING_OPTIONS.maxChars}-${DEFAULT_CHUNKING_OPTIONS.overlapChars}-v1`;

export const DEFAULT_MOCK_EMBEDDING_MODEL = "deterministic-mock-embedding-v1";
export const DEFAULT_MOCK_EMBEDDING_DIMENSIONS = 32;
export const DEFAULT_VECTOR_SEARCH_TOP_K = 5;
export const MAX_VECTOR_SEARCH_TOP_K = 50;
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "hybrid";
export const DEFAULT_RETRIEVAL_CANDIDATE_LIMIT = 20;
export const DEFAULT_VECTOR_WEIGHT = 0.65;
export const DEFAULT_KEYWORD_WEIGHT = 0.35;

/**
 * 创建 RAG package 的边界摘要，明确本阶段只提供骨架和稳定类型。
 *
 * @returns RAG package 的职责边界和当前实现状态。
 */
export function createRagPackageSummary(): RagPackageSummary {
  return {
    packageName: "@aiagent/rag",
    boundary: "chunking_embedding_retrieval_citation_answer",
    runtimeState: "hybrid_retrieval_ready"
  };
}

/**
 * 创建 deterministic mock embedding client。
 *
 * 第一版使用 mock 而不接真实 provider，是为了让 RAG 索引和检索测试完全稳定、
 * 不依赖 API key、网络或供应商限流；后续接 OpenAI/通义时只需替换 EmbeddingClient 边界。
 *
 * @param options 可选模型名和向量维度，默认维度足够覆盖单测语义相似度。
 * @returns 实现 EmbeddingClient 的 deterministic mock client。
 */
export function createDeterministicMockEmbeddingClient(
  options: Partial<DeterministicMockEmbeddingClientOptions> = {}
): EmbeddingClient {
  return new DeterministicMockEmbeddingClient({
    model: options.model ?? DEFAULT_MOCK_EMBEDDING_MODEL,
    dimensions: options.dimensions ?? DEFAULT_MOCK_EMBEDDING_DIMENSIONS
  });
}

/**
 * 创建内存向量库。
 *
 * 内存实现只适合单测、学习和本地 demo，不提供持久化、并发隔离或跨进程共享；
 * 后续接 Qdrant/pgvector 时应替换 VectorStore 实现，而不是改调用方。
 *
 * @param options 可选固定向量维度；不传时会由第一次 upsert 的 chunk 推断。
 * @returns 实现 VectorStore 的内存向量库。
 */
export function createInMemoryVectorStore(options: { dimensions?: number } = {}): VectorStore {
  return new InMemoryVectorStore(options.dimensions);
}

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
 * 创建 Data Sources runtime。
 *
 * 文档/版本/chunk lineage 由注入的 repository 持久化（生产为 PostgreSQL adapter）；
 * 缺省使用内存 repository，保持 eval、MCP 等本地调用方零配置兼容。
 * 向量索引仍是进程内 VectorStore，只服务当前进程检索。
 *
 * @param options 可选 repository 注入；缺省创建内存 repository。
 * @returns 可执行 ingest、list、search 和 grounded answer 的 runtime。
 */
export function createDataSourceRuntime(options: { repository?: RagDocumentRepository } = {}): DataSourceRuntime {
  return new InMemoryDataSourceRuntime(options.repository ?? createInMemoryRagDocumentRepository());
}

/**
 * 从检索候选创建可展示 citation，确保回答来源能回到 document、source、heading 和 chunkIndex。
 *
 * @param result 检索命中的 chunk 和分数。
 * @returns 标准 citation DTO。
 */
export function createCitationFromRetrievedChunk(result: RetrievedChunk): Citation {
  return {
    chunkId: result.chunk.chunkId,
    documentId: result.chunk.documentId,
    source: result.chunk.source,
    heading: result.chunk.heading,
    chunkIndex: result.chunk.chunkIndex,
    quote: createQuote(result.chunk.text),
    pageNumber: result.chunk.pageNumber ?? result.chunk.page,
    confidence: result.scoreBreakdown.finalScore
  };
}

/**
 * 把检索候选投影为 API/UI 可展示的 retrieval result。
 *
 * @param result 检索命中的 chunk 和 score breakdown。
 * @returns 包含 citation 的 retrieval result DTO。
 */
export function createRetrievalResultFromRetrievedChunk(result: RetrievedChunk): RetrievalResult {
  return {
    chunkId: result.chunk.chunkId,
    documentId: result.chunk.documentId,
    score: result.score,
    rank: result.rank,
    text: result.chunk.text,
    scoreBreakdown: result.scoreBreakdown,
    citation: createCitationFromRetrievedChunk(result)
  };
}

/**
 * Data Sources runtime 实现，负责把 filings ingestion、lineage 持久化和 RAG 检索链路串起来。
 *
 * 文档/版本/chunk 事实源是注入的 repository；内存 VectorStore 只承载当前进程的向量索引。
 */
class InMemoryDataSourceRuntime implements DataSourceRuntime {
  private readonly embeddingClient = createDeterministicMockEmbeddingClient();
  private readonly vectorStore = createInMemoryVectorStore();
  private readonly repository: RagDocumentRepository;
  private readonly embeddedChunksById = new Map<string, EmbeddedChunk>();

  /**
   * 创建 runtime 实例。
   *
   * @param repository 文档 lineage repository（PostgreSQL 或内存 adapter）。
   */
  public constructor(repository: RagDocumentRepository) {
    this.repository = repository;
  }

  /**
   * ingest Markdown/TXT 文档：解析、切块、持久化 lineage、生成 embedding 并写入内存向量库。
   *
   * 持久化语义：
   * - externalId 是 source/fileName/fileType 的 SHA-256，同来源重复 ingest 落到同一文档；
   * - contentChecksum 相同的已 indexed 版本直接幂等命中（deduplicated），不重复建版本和 chunk，
   *   但仍用 repository 返回的 chunks 重新 embed 并 upsert，保证同进程 search 可用；
   * - 解析或切块失败也落 failed 版本（结构化错误），修复内容后可重试产生新版本。
   *
   * @param request API 校验后的 data source ingestion 请求。
   * @param context owner 与 scope；缺省匿名落 shared scope。
   * @returns 文档、chunks、版本号、幂等标记和索引数量；失败时返回结构化 RAG 错误。
   */
  public async ingest(
    request: DataSourceIngestRequestDto,
    context: DataSourceIngestContext = {}
  ): Promise<DataSourceRuntimeResult<DataSourceIngestResponseDto>> {
    const ownerUserId = context.ownerUserId ?? null;
    const scope = context.scope ?? (ownerUserId ? "private" : "shared");
    const ownerScopeViolation = validateRagOwnerScope({ ownerUserId, scope });

    if (ownerScopeViolation !== undefined) {
      return {
        ok: false,
        error: {
          code: "ingestion_failed",
          message: "ingest 请求的 owner/scope 组合非法。",
          details: { reason: ownerScopeViolation }
        }
      };
    }

    if (!isSafeRagSourceUri(request.source)) {
      return {
        ok: false,
        error: {
          code: "ingestion_failed",
          message: "Data source 标识不合法：仅支持 http(s) URL、mock:/demo: URI 或相对逻辑标识。",
          details: { reason: "unsafe_source_uri" }
        }
      };
    }

    // sourceUri 是脱敏后的逻辑标识：http(s) URL 剥离 query/fragment，
    // 同一文档带不带 token 命中同一 lineage，落库与 DTO 返回值永远不含敏感参数。
    const sourceUri = normalizeRagSourceUri(request.source);
    const fileType = detectFilingFileType(request.fileName, request.contentType);
    const externalId = createRagContentChecksum(`${sourceUri}|${request.fileName}|${fileType ?? "unknown"}`);
    const contentChecksum = createRagContentChecksum(request.content);
    const contentType = request.contentType?.trim() || "unknown";
    const now = new Date().toISOString();
    const lineageBase = {
      ownerUserId,
      scope,
      sourceType: resolveRagSourceType(sourceUri),
      externalId,
      sourceUri,
      contentType,
      contentChecksum,
      content: request.content,
      parserVersion: RAG_PARSER_VERSION,
      chunkerVersion: RAG_CHUNKER_VERSION,
      now
    } as const;

    const ingestionResult = ingestFiling({
      source: sourceUri,
      fileName: request.fileName,
      contentType: request.contentType,
      content: request.content
    });

    if (!ingestionResult.ok) {
      const error = {
        code: "ingestion_failed" as const,
        message: ingestionResult.error.message,
        details: {
          filingCode: ingestionResult.error.code,
          ...ingestionResult.error.details
        }
      };
      await this.saveLineage({
        ...lineageBase,
        title: request.fileName,
        outcome: {
          status: "failed",
          error: { code: ingestionResult.error.code, message: ingestionResult.error.message, details: ingestionResult.error.details }
        }
      });
      return { ok: false, error };
    }

    const chunkingResult = chunkIngestedFilingDocument(ingestionResult.document);

    if (!chunkingResult.ok) {
      await this.saveLineage({
        ...lineageBase,
        title: ingestionResult.document.title,
        outcome: {
          status: "failed",
          error: { code: chunkingResult.error.code, message: chunkingResult.error.message, details: chunkingResult.error.details }
        }
      });
      return { ok: false, error: chunkingResult.error };
    }

    const saved = await this.saveLineage({
      ...lineageBase,
      title: ingestionResult.document.title,
      outcome: {
        status: "indexed",
        chunks: chunkingResult.chunks.map(toNewChunkRecord)
      }
    });

    if (!saved.ok) {
      return { ok: false, error: saved.error };
    }

    // 统一从 repository 返回的记录重建 RagChunkDto，幂等命中与新建版本走完全相同的形状。
    const chunks = saved.result.chunks.map(ragChunkRecordToChunk);
    const embeddingResult = await this.embeddingClient.embedTexts(chunks.map((chunk) => chunk.text));

    if (!embeddingResult.ok) {
      return { ok: false, error: embeddingResult.error };
    }

    const embeddedChunks = chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddingResult.embeddings[index].vector,
      embeddingModel: embeddingResult.model
    }));
    const upsertResult = await this.vectorStore.upsertChunks(embeddedChunks);

    if (!upsertResult.ok) {
      return {
        ok: false,
        error: {
          code: "indexing_failed",
          message: upsertResult.error.message,
          details: upsertResult.error.details
        }
      };
    }

    embeddedChunks.forEach((chunk) => this.embeddedChunksById.set(chunk.chunkId, chunk));

    return {
      ok: true,
      data: {
        document: { ...ingestionResult.document, documentId: saved.result.document.id },
        chunks,
        indexedChunkCount: embeddedChunks.length,
        documentVersion: saved.result.version.version,
        deduplicated: saved.result.kind === "existing"
      }
    };
  }

  /**
   * 经 repository 分页列出可见文档摘要。
   *
   * @param options owner、cursor 与 limit；缺省匿名第一页。
   * @returns 文档摘要页与下一页 cursor。
   */
  public async listDocuments(
    options: DataSourceListOptions = {}
  ): Promise<{ documents: DataSourceDocumentDto[]; nextCursor: string | null }> {
    return this.repository.listDocuments({
      ownerUserId: options.ownerUserId ?? null,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });
  }

  /**
   * 经 repository 分页列出可见 chunks，并重建为不暴露向量的 RagChunkDto。
   *
   * @param options owner、可选 documentId、cursor 与 limit。
   * @returns chunk 页与下一页 cursor。
   */
  public async listChunks(
    options: DataSourceListChunksOptions = {}
  ): Promise<{ chunks: RagChunk[]; nextCursor: string | null }> {
    const page = await this.repository.listChunks({
      ownerUserId: options.ownerUserId ?? null,
      ...(options.documentId !== undefined ? { documentId: options.documentId } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });

    return {
      chunks: page.chunks.map(ragChunkRecordToChunk),
      nextCursor: page.nextCursor
    };
  }

  /**
   * 执行 RAG search，并返回带 citation 的 retrieval results。
   *
   * @param query 用户查询。
   * @param options topK、mode 等检索选项。
   * @returns search 结果和脱敏 trace event。
   */
  public async search(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<DataSourceRuntimeResult<RagSearchRuntimeResponse>> {
    const retrievalResult = await this.createRetriever().retrieve(query, options);
    const trace = createTraceRetrievalEvent(query, retrievalResult);

    if (!retrievalResult.ok) {
      return {
        ok: false,
        error: retrievalResult.error
      };
    }

    return {
      ok: true,
      data: {
        results: retrievalResult.results.map(createRetrievalResultFromRetrievedChunk),
        trace
      }
    };
  }

  /**
   * 基于召回结果合成短研究摘要；证据不足时明确返回未知，不编造结论。
   *
   * @param question 用户问题。
   * @param options topK、mode 等检索选项。
   * @returns grounded answer 和 retrieval trace。
   */
  public async answer(
    question: string,
    options: RetrievalOptions = {}
  ): Promise<DataSourceRuntimeResult<RagAnswerRuntimeResponse>> {
    const retrievalResult = await this.createRetriever().retrieve(question, options);
    const trace = createTraceRetrievalEvent(question, retrievalResult);

    if (!retrievalResult.ok) {
      return {
        ok: false,
        error: retrievalResult.error
      };
    }

    return {
      ok: true,
      data: {
        answer: synthesizeRagAnswer(question, retrievalResult.results),
        trace
      }
    };
  }

  /**
   * 持久化 ingestion 终态；repository 异常映射为结构化错误，不向调用方泄漏原始异常。
   *
   * @param input saveIngestion 输入。
   * @returns 成功时返回 saveIngestion 结果，失败时返回结构化错误。
   */
  private async saveLineage(
    input: SaveRagIngestionInput
  ): Promise<{ ok: true; result: SaveRagIngestionResult } | { ok: false; error: RagStructuredError }> {
    try {
      return { ok: true, result: await this.repository.saveIngestion(input) };
    } catch {
      return {
        ok: false,
        error: {
          code: "indexing_failed",
          message: "RAG 文档 lineage 持久化失败，请稍后重试。"
        }
      };
    }
  }

  /**
   * 基于当前内存 chunks 创建检索器。
   *
   * @returns 绑定当前语料的 hybrid retriever。
   */
  private createRetriever(): Retriever {
    return createHybridRetriever({
      embeddingClient: this.embeddingClient,
      vectorStore: this.vectorStore,
      chunks: [...this.embeddedChunksById.values()]
    });
  }
}

/**
 * deterministic mock embedding 的运行时实现。
 *
 * 通过规范化 token、稳定 hash 和 L2 normalize 生成固定维度向量，使同一文本每次输出完全一致；
 * 这能先验证索引、检索和错误边界，避免把真实 embedding provider 的网络变量混入 Week 2 单测。
 */
class DeterministicMockEmbeddingClient implements EmbeddingClient {
  private readonly model: string;
  private readonly dimensions: number;

  /**
   * 创建 mock embedding client。
   *
   * @param options 模型名和向量维度。
   */
  public constructor(options: DeterministicMockEmbeddingClientOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  /**
   * 将文本数组转换为稳定向量。
   *
   * @param texts 待 embedding 的文本数组。
   * @returns 成功时返回每段文本的向量和 usage；维度非法时返回结构化错误。
   */
  public async embedTexts(texts: readonly string[]): Promise<EmbeddingResult> {
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      return {
        ok: false,
        error: {
          code: "invalid_embedding_input",
          message: "embedding dimensions 必须是大于 0 的整数。",
          details: {
            dimensions: this.dimensions
          }
        }
      };
    }

    const embeddings = texts.map((text, index) => ({
      text,
      vector: createDeterministicEmbeddingVector(text, this.dimensions),
      index,
      model: this.model
    }));

    return {
      ok: true,
      embeddings,
      usage: {
        inputTexts: texts.length,
        inputCharacters: texts.reduce((total, text) => total + text.length, 0)
      },
      dimensions: this.dimensions,
      model: this.model
    };
  }
}

/**
 * 内存向量库实现，用 Map 按 chunkId 替换写入，保持 upsert 行为可预测。
 */
class InMemoryVectorStore implements VectorStore {
  private readonly chunksById = new Map<string, EmbeddedChunk>();
  private dimensions: number | undefined;

  /**
   * 创建内存向量库实例。
   *
   * @param dimensions 可选固定向量维度；不传时由第一次 upsert 推断。
   */
  public constructor(dimensions?: number) {
    this.dimensions = dimensions;
  }

  /**
   * 写入 embedded chunks，相同 chunkId 会被替换。
   *
   * @param chunks 已带 embedding 的 chunks。
   * @returns 写入数量、替换数量和当前索引规模；维度不一致时返回结构化错误。
   */
  public async upsertChunks(chunks: readonly EmbeddedChunk[]): Promise<VectorStoreResult> {
    const dimensionsResult = this.resolveUpsertDimensions(chunks);

    if (!dimensionsResult.ok) {
      return dimensionsResult;
    }

    let replacedCount = 0;

    chunks.forEach((chunk) => {
      if (this.chunksById.has(chunk.chunkId)) {
        replacedCount += 1;
      }

      this.chunksById.set(chunk.chunkId, { ...chunk, embedding: [...chunk.embedding] });
    });

    return {
      ok: true,
      upsertedCount: chunks.length,
      replacedCount,
      totalCount: this.chunksById.size,
      dimensions: dimensionsResult.dimensions
    };
  }

  /**
   * 按 cosine similarity 检索 topK chunks，并支持 documentId/source metadata 过滤。
   *
   * @param queryVector 查询向量。
   * @param options topK 和 metadata filter；topK 缺省为小值并受上限保护。
   * @returns 命中列表；空索引返回空数组，维度错误返回结构化错误。
   */
  public async search(
    queryVector: EmbeddingVector,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult> {
    const topKResult = normalizeTopK(options.topK);

    if (!topKResult.ok) {
      return topKResult;
    }

    if (this.chunksById.size === 0) {
      return {
        ok: true,
        matches: []
      };
    }

    if (this.dimensions !== undefined && queryVector.length !== this.dimensions) {
      return {
        ok: false,
        error: {
          code: "vector_store_dimension_mismatch",
          message: "query vector 维度与向量库维度不一致。",
          details: {
            expectedDimensions: this.dimensions,
            actualDimensions: queryVector.length
          }
        }
      };
    }

    const matches = [...this.chunksById.values()]
      .filter((chunk) => matchesVectorSearchFilter(chunk, options.filter))
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVector, chunk.embedding)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topKResult.topK)
      .map((match, index) => ({
        ...match,
        rank: index + 1
      }));

    return {
      ok: true,
      matches
    };
  }

  /**
   * 校验 upsert chunks 的维度，并在首次写入时确定 store 维度。
   *
   * @param chunks 待写入 chunks。
   * @returns 合法时返回向量库维度，否则返回结构化错误。
   */
  private resolveUpsertDimensions(
    chunks: readonly EmbeddedChunk[]
  ): { ok: true; dimensions: number } | { ok: false; error: RagStructuredError } {
    if (chunks.length === 0) {
      return {
        ok: true,
        dimensions: this.dimensions ?? 0
      };
    }

    const firstDimensions = this.dimensions ?? chunks[0]?.embedding.length ?? 0;

    if (!Number.isInteger(firstDimensions) || firstDimensions <= 0) {
      return {
        ok: false,
        error: {
          code: "embedding_dimension_mismatch",
          message: "embedded chunk 必须包含非空向量。",
          details: {
            expectedDimensions: this.dimensions ?? null,
            actualDimensions: firstDimensions
          }
        }
      };
    }

    const mismatchedChunk = chunks.find((chunk) => chunk.embedding.length !== firstDimensions);

    if (mismatchedChunk) {
      return {
        ok: false,
        error: {
          code: "embedding_dimension_mismatch",
          message: "同一个向量库中的 chunk embedding 维度必须一致。",
          details: {
            chunkId: mismatchedChunk.chunkId,
            expectedDimensions: firstDimensions,
            actualDimensions: mismatchedChunk.embedding.length
          }
        }
      };
    }

    this.dimensions = firstDimensions;

    return {
      ok: true,
      dimensions: firstDimensions
    };
  }
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
function createQueryPreview(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();

  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

/**
 * 将 ingestion 文档切分为可检索 chunk。
 *
 * @param document filings package 输出的结构化文档，包含 blocks、source 和 documentId。
 * @param options chunk 策略配置；默认使用 heading-aware 以保留公告章节线索。
 * @returns 成功时返回连续 chunkIndex 的 chunks，配置非法时返回结构化错误。
 */
export function chunkIngestedFilingDocument(
  document: IngestedFilingDocumentDto,
  options: ChunkingOptions = DEFAULT_CHUNKING_OPTIONS
): ChunkingResult {
  return chunkDocumentBlocks(
    {
      documentId: document.documentId,
      source: document.source,
      blocks: document.blocks
    },
    options
  );
}

/**
 * 将 ingestion blocks 切分为 chunk。
 *
 * fixed-size 适合没有结构的 TXT 或长文本，行为稳定但可能切断语义段落。
 * heading-aware 优先保留 Markdown/公告解析得到的 heading，便于后续 citation 显示章节；
 * 当单个 block 超过 maxChars 时仍回退到 fixed-size，避免生成过大的不可控 chunk。
 *
 * @param input 文档身份、来源和 ingestion block 列表。
 * @param options chunk 策略配置。
 * @returns chunking 结果，空 blocks 或空文本会返回空 chunks。
 */
export function chunkDocumentBlocks(
  input: ChunkBlocksInput,
  options: ChunkingOptions = DEFAULT_CHUNKING_OPTIONS
): ChunkingResult {
  const validationError = validateChunkingOptions(options);

  if (validationError) {
    return {
      ok: false,
      error: validationError
    };
  }

  const chunks: RagChunk[] = [];

  if (options.strategy === "fixed_size") {
    const text = input.blocks.map((block) => block.text).join("\n\n");
    const result = createFixedSizeChunks({
      documentId: input.documentId,
      source: input.source,
      text,
      baseCharStart: 0,
      heading: firstDefined(input.blocks.map((block) => block.heading)),
      page: firstDefined(input.blocks.map((block) => block.pageNumber)),
      metadata: {
        strategy: "fixed_size",
        blockIds: input.blocks.map((block) => block.id).join(","),
        lineStart: firstDefined(input.blocks.map((block) => block.lineStart)) ?? null,
        lineEnd: lastDefined(input.blocks.map((block) => block.lineEnd)) ?? null
      },
      options
    });

    chunks.push(...result);
  } else {
    let baseCharStart = 0;

    input.blocks.forEach((block) => {
      const blockText = block.text.trim();
      const blockCharStart = baseCharStart;
      baseCharStart += block.text.length + 2;

      if (blockText.length === 0) {
        return;
      }

      chunks.push(
        ...createFixedSizeChunks({
          documentId: input.documentId,
          source: input.source,
          text: blockText,
          baseCharStart: blockCharStart,
          heading: block.heading,
          page: block.pageNumber,
          metadata: {
            strategy: "heading_aware",
            blockId: block.id,
            lineStart: block.lineStart,
            lineEnd: block.lineEnd,
            pageNumber: block.pageNumber ?? null,
            heading: block.heading ?? null,
            ...block.metadata
          },
          options
        })
      );
    });
  }

  return {
    ok: true,
    chunks: chunks.map((chunk, chunkIndex) => withChunkIdentity(chunk, chunkIndex))
  };
}

/**
 * 直接切分一段纯文本，便于单元测试和后续非 filings 来源复用。
 *
 * @param input 文档身份、来源、文本和可选来源位置。
 * @param options chunk 策略配置。
 * @returns chunking 结果；空文本返回空 chunks。
 */
export function chunkText(
  input: ChunkTextInput,
  options: ChunkingOptions = {
    ...DEFAULT_CHUNKING_OPTIONS,
    strategy: "fixed_size"
  }
): ChunkingResult {
  const validationError = validateChunkingOptions(options);

  if (validationError) {
    return {
      ok: false,
      error: validationError
    };
  }

  const text = input.text.trim();

  if (text.length === 0) {
    return {
      ok: true,
      chunks: []
    };
  }

  return {
    ok: true,
    chunks: createFixedSizeChunks({
      documentId: input.documentId,
      source: input.source,
      text,
      baseCharStart: 0,
      heading: input.heading,
      page: input.page,
      metadata: {
        strategy: options.strategy,
        lineStart: input.lineStart ?? null,
        lineEnd: input.lineEnd ?? null,
        heading: input.heading ?? null,
        ...input.metadata
      },
      options
    }).map((chunk, chunkIndex) => withChunkIdentity(chunk, chunkIndex))
  };
}

/**
 * 从检索结果和引用创建 grounded answer 占位对象，后续会接入真实生成模型。
 *
 * @param input 回答文本、检索结果和引用列表。
 * @returns 标准 RAG answer 结构。
 */
export function createRagAnswer(input: {
  answer: string;
  citations: Citation[];
  retrievalResults: RetrievalResult[];
}): RagAnswer {
  return {
    answer: input.answer,
    citations: [...input.citations],
    retrievalResults: [...input.retrievalResults]
  };
}

/**
 * 根据检索证据生成 deterministic grounded answer。
 *
 * 第一版不调用 LLM，而是把高相关 chunk 摘成简短摘要；当没有足够匹配证据时明确说明资料不足，
 * 用来验证 unknown answer policy 和 citation 数据流。
 *
 * 改进点：
 * - 过滤掉 Markdown 解析产生的 heading-only 块，避免答案中出现“盈利能力：盈利能力”这类无信息条目。
 * - 证据句优先选择包含命中词的最长句子，而不是简单取第一句，提高关键词覆盖和可解释性。
 *
 * @param question 用户问题。
 * @param results 检索结果。
 * @returns 带 citations 和 retrieval results 的 RAG answer。
 */
function synthesizeRagAnswer(question: string, results: readonly RetrievedChunk[]): RagAnswer {
  const retrievalResults = results.map(createRetrievalResultFromRetrievedChunk);
  const contentResults = results.filter((result) => !isHeadingOnlyChunk(result.chunk));
  const sufficientResults = contentResults.filter(isEvidenceSufficient);

  if (sufficientResults.length === 0) {
    return createRagAnswer({
      answer: `当前资料不足，无法可靠回答“${question.trim()}”。请先 ingest 包含该问题信息的 Markdown/TXT 文档，或换一个与现有资料更匹配的问题。`,
      citations: retrievalResults.slice(0, 2).map((result) => result.citation),
      retrievalResults
    });
  }

  const citations = sufficientResults.map(createCitationFromRetrievedChunk);
  const evidenceLines = sufficientResults.slice(0, 3).map((result, index) => {
    const heading = result.chunk.heading ? `${result.chunk.heading}：` : "";

    return `[${index + 1}] ${heading}${createAnswerSentence(result.chunk.text, result.scoreBreakdown.matchedTerms)}`;
  });

  return createRagAnswer({
    answer: `基于当前已 ingest 资料，可以得到以下摘要：\n${evidenceLines.join("\n")}`,
    citations,
    retrievalResults
  });
}

/**
 * 判断 chunk 是否只是 Markdown heading 块，没有实质内容。
 *
 * @param chunk RAG chunk。
 * @returns 是 heading-only 块时返回 true。
 */
function isHeadingOnlyChunk(chunk: RagChunk): boolean {
  if (!chunk.heading) {
    return false;
  }

  const text = chunk.text.trim();
  const heading = chunk.heading.trim();

  return text.length <= heading.length + 5 || text.replace(/[:：\s]/g, "") === heading.replace(/[:：\s]/g, "");
}

/**
 * 判断单条召回结果是否足以进入 answer synthesis。
 *
 * @param result 检索结果。
 * @returns 相关性足够时返回 true。
 */
function isEvidenceSufficient(result: RetrievedChunk): boolean {
  const hasMeaningfulTerm = result.scoreBreakdown.matchedTerms.some(
    (term) => term.length > 1 && !["公司", "如何", "多少", "是什么"].includes(term)
  );

  return hasMeaningfulTerm && (result.scoreBreakdown.queryTermCoverage >= 0.15 || result.scoreBreakdown.finalScore >= 0.42);
}

/**
 * 截取适合 answer 主体展示的证据句。
 *
 * 优先返回包含命中词的最长句子，命中词为空时回退到第一句；
 * 这样能让答案更有可能覆盖用户查询中的关键词，也便于后续 eval correctness 检查。
 *
 * @param text chunk 原文。
 * @param matchedTerms 检索命中的词，用于选择最有信息量的句子。
 * @returns 短句摘要。
 */
function createAnswerSentence(text: string, matchedTerms: readonly string[] = []): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[。！？!?；;])\s*/u).filter((item) => item.trim().length > 0);

  if (sentences.length === 0) {
    return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
  }

  if (matchedTerms.length === 0) {
    const first = sentences[0] ?? normalized;
    return first.length > 120 ? `${first.slice(0, 120)}...` : first;
  }

  const scoredSentences = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const hitCount = matchedTerms.filter((term) => lower.includes(term.toLowerCase())).length;
    return { sentence, hitCount, length: sentence.length };
  });

  scoredSentences.sort((left, right) => {
    if (right.hitCount !== left.hitCount) {
      return right.hitCount - left.hitCount;
    }

    return right.length - left.length;
  });

  const best = scoredSentences[0]?.sentence ?? normalized;

  return best.length > 120 ? `${best.slice(0, 120)}...` : best;
}

/**
 * 截取 citation quote，避免 UI 中引用片段过长。
 *
 * @param text chunk 原文。
 * @returns citation 引文片段。
 */
function createQuote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}

/**
 * 校验 ingest source 是否符合写入口安全边界。
 *
 * 拒绝：绝对路径（`/`、`~` 开头）、Windows 盘符（`C:`）、`file:` URI、包含 `..` 的
 * 路径段、控制字符、反斜杠，以及带 userinfo（`user@`/`user:pass@`）的 http(s) URL；
 * 允许：合法的 http(s) URL，以及由字母数字和 `-_.:/` 组成的相对逻辑标识
 * （如 `demo/annual-report`、`mock://filings/x.md`）。
 * API 层与 runtime 共用同一校验，保证 sourceUri 落库前已被白名单过滤，
 * 因此列表 DTO 中的 sourceUri 不需要额外脱敏。
 *
 * @param source ingest 请求的 source。
 * @returns 符合安全边界返回 true。
 */
export function isSafeRagSourceUri(source: string): boolean {
  const value = source.trim();
  if (value.length === 0 || value.length > 512) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      // userinfo 是凭证载体，一律拒绝，避免账号密码进入 lineage 和共享列表。
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }
  if (/[\x00-\x1f]/.test(value)) {
    return false;
  }
  if (value.includes("\\")) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("~")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  if (/^file:/i.test(value)) {
    return false;
  }
  if (value.split("/").includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9\-_.:/]+$/.test(value);
}

/** source URI query 脱敏 denylist：常见凭证/签名/会话键（大小写不敏感匹配）。 */
const SENSITIVE_SOURCE_QUERY_KEYS = new Set([
  "token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "signature",
  "sig",
  "access_token",
  "refresh_token",
  "auth",
  "authorization",
  "password",
  "credential",
  "credentials",
  "session",
  "sessionid",
  "expires",
  "expire"
]);

/** 云厂商签名参数前缀（大小写不敏感匹配），如 x-amz-signature、x-goog-credential。 */
const SENSITIVE_SOURCE_QUERY_PREFIXES = ["x-amz-", "x-goog-"];

/**
 * 规范化 ingest source 为可持久化的 canonical sourceUri。
 *
 * 该函数同时服务两个目标：
 * - 脱敏：fragment 一律剥离；query 中命中 denylist（token/api_key/signature/session 等
 *   常见凭证键，以及 `x-amz-`/`x-goog-` 前缀的云签名参数，大小写不敏感）的键值对删除，
 *   敏感值不会进入 lineage，也不会出现在 shared/demo 列表 DTO 中。
 * - 资源 identity：未命中 denylist 的参数视为资源标识（如 `?id=filing-A`），
 *   按键名（同键按值）排序后保留；这样 `?id=A` 与 `?id=B` 是不同逻辑文档，
 *   而同一资源带不带 token 都命中同一 externalId。
 *
 * http(s) URL 返回 `origin + pathname + 规范化 query`；非 URL 逻辑标识已通过
 * `isSafeRagSourceUri` 白名单，原样返回。
 *
 * @param source 已通过安全校验的 source。
 * @returns 脱敏且保留资源标识参数的 canonical sourceUri。
 */
export function normalizeRagSourceUri(source: string): string {
  const value = source.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const kept = [...url.searchParams.entries()]
        .filter(([key]) => !isSensitiveSourceQueryKey(key))
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
        );
      const query = kept.map(([key, entryValue]) => `${encodeURIComponent(key)}=${encodeURIComponent(entryValue)}`).join("&");
      return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * 判断 query 键是否命中脱敏 denylist（大小写不敏感，含云签名前缀）。
 *
 * @param key query 参数名。
 * @returns 敏感键返回 true。
 */
function isSensitiveSourceQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_SOURCE_QUERY_KEYS.has(normalized)
    || SENSITIVE_SOURCE_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 计算 ingestion lineage 使用的 SHA-256 校验和（hex）。
 *
 * @param value 待哈希文本。
 * @returns SHA-256 hex 字符串。
 */
function createRagContentChecksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 从 ingest source URI 推导文档来源类型。
 *
 * http(s) 视为远程地址，mock/demo 前缀视为演示文本，其余按本地文件处理；
 * 这只是 lineage 分类，不放宽 API 层已有的 ingestion 安全边界。
 *
 * @param source ingest 请求的 source。
 * @returns 文档来源类型。
 */
function resolveRagSourceType(source: string): RagDocumentSourceType {
  if (/^https?:\/\//i.test(source)) {
    return "remote_url";
  }
  if (/^(mock|demo)(:|\/|$)/i.test(source)) {
    return "mock_text";
  }
  return "local_file";
}

/**
 * 把 chunker 输出的 RagChunk 映射为待持久化 chunk 记录。
 *
 * charStart/charEnd/startOffset/endOffset 没有独立列，统一并入 metadata JSONB，
 * 读回时可还原出与 chunker 输出完全一致的 RagChunkDto 形状。
 *
 * @param chunk chunker 输出 chunk。
 * @returns 待持久化 chunk 记录。
 */
function toNewChunkRecord(chunk: RagChunk): NewRagChunkRecord {
  const lineStart = readMetadataNumber(chunk.metadata, "lineStart");
  const lineEnd = readMetadataNumber(chunk.metadata, "lineEnd");
  const pageNumber = chunk.pageNumber ?? chunk.page;

  return {
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    metadata: {
      ...chunk.metadata,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset
    },
    contentChecksum: createRagContentChecksum(chunk.text)
  };
}

/**
 * 把持久化 chunk 记录重建为 RagChunkDto，偏移字段从 metadata JSONB 还原。
 *
 * @param record 持久化 chunk 记录。
 * @returns 与 chunker 输出形状一致的 RagChunkDto。
 */
function ragChunkRecordToChunk(record: RagChunkRecord): RagChunk {
  const charStart = readMetadataNumber(record.metadata, "charStart") ?? 0;
  const charEnd = readMetadataNumber(record.metadata, "charEnd") ?? record.text.length;

  return {
    chunkId: record.chunkId,
    id: record.chunkId,
    documentId: record.documentId,
    source: record.source,
    chunkIndex: record.chunkIndex,
    text: record.text,
    charStart,
    charEnd,
    startOffset: readMetadataNumber(record.metadata, "startOffset") ?? charStart,
    endOffset: readMetadataNumber(record.metadata, "endOffset") ?? charEnd,
    ...(record.pageNumber !== undefined ? { page: record.pageNumber, pageNumber: record.pageNumber } : {}),
    ...(record.heading !== undefined ? { heading: record.heading } : {}),
    metadata: { ...record.metadata }
  };
}

/**
 * 从 chunk metadata 读取数值字段，非数值一律视为缺失。
 *
 * @param metadata chunk metadata。
 * @param key 字段名。
 * @returns 数值或 undefined。
 */
function readMetadataNumber(metadata: Record<string, string | number | boolean | null>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * 创建可返回 API/UI 的 retrieval trace event。
 *
 * @param query 原始问题或搜索词。
 * @param result 检索结果。
 * @returns trace retrieval event DTO。
 */
function createTraceRetrievalEvent(
  query: string,
  result: HybridRetrievalResult
): TraceRetrievalEventDto {
  const now = new Date().toISOString();

  return {
    type: "retrieval",
    id: `retrieval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    traceId: "rag_runtime_trace",
    requestId: "rag_runtime_request",
    createdAt: now,
    queryPreview: result.trace.queryPreview || createQueryPreview(query),
    mode: result.trace.mode,
    topK: result.trace.topK,
    candidateLimit: result.trace.candidateLimit,
    durationMs: result.trace.durationMs,
    chunkIds: result.trace.chunkIds,
    scoreSummary: result.trace.scoreSummary,
    ok: result.ok,
    error: result.ok
      ? undefined
      : {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details
        }
  };
}

interface FixedSizeChunkDraft {
  documentId: string;
  source: string;
  id: string;
  chunkId: string;
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  startOffset: number;
  endOffset: number;
  page?: number;
  pageNumber?: number;
  heading?: string;
  metadata: Record<string, string | number | boolean | null>;
}

interface FixedSizeInput {
  documentId: string;
  source: string;
  text: string;
  baseCharStart: number;
  heading?: string;
  page?: number;
  metadata: Record<string, string | number | boolean | null>;
  options: ChunkingOptions;
}

/**
 * 校验 chunk 参数，尤其防止 overlap 大于等于窗口导致游标不前进。
 *
 * @param options 调用方传入的 chunk 配置。
 * @returns 配置合法时返回 undefined，否则返回结构化错误。
 */
function validateChunkingOptions(options: ChunkingOptions): RagStructuredError | undefined {
  if (options.strategy !== "fixed_size" && options.strategy !== "heading_aware") {
    return {
      code: "invalid_chunking_options",
      message: "chunk 策略必须是 fixed_size 或 heading_aware。",
      details: {
        strategy: options.strategy
      }
    };
  }

  if (!Number.isInteger(options.maxChars) || options.maxChars <= 0) {
    return {
      code: "invalid_chunking_options",
      message: "maxChars 必须是大于 0 的整数。",
      details: {
        maxChars: options.maxChars
      }
    };
  }

  if (!Number.isInteger(options.overlapChars) || options.overlapChars < 0) {
    return {
      code: "invalid_chunking_options",
      message: "overlapChars 必须是大于等于 0 的整数。",
      details: {
        overlapChars: options.overlapChars
      }
    };
  }

  if (options.overlapChars >= options.maxChars) {
    return {
      code: "invalid_chunking_options",
      message: "overlapChars 必须小于 maxChars，避免 chunk 游标无法前进。",
      details: {
        maxChars: options.maxChars,
        overlapChars: options.overlapChars
      }
    };
  }

  return undefined;
}

/**
 * 按字符窗口切分文本，并用 overlap 保留相邻 chunk 的上下文。
 *
 * @param input 已校验配置和来源信息。
 * @returns 未补齐最终 chunkIndex 的 chunk 草稿。
 */
function createFixedSizeChunks(input: FixedSizeInput): FixedSizeChunkDraft[] {
  const text = input.text.trim();

  if (text.length === 0) {
    return [];
  }

  const chunks: FixedSizeChunkDraft[] = [];
  const step = input.options.maxChars - input.options.overlapChars;

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + input.options.maxChars, text.length);
    const chunkText = text.slice(start, end);
    const charStart = input.baseCharStart + start;
    const charEnd = input.baseCharStart + end;

    chunks.push({
      documentId: input.documentId,
      source: input.source,
      id: "",
      chunkId: "",
      chunkIndex: -1,
      text: chunkText,
      charStart,
      charEnd,
      startOffset: charStart,
      endOffset: charEnd,
      page: input.page,
      pageNumber: input.page,
      heading: input.heading,
      metadata: {
        ...input.metadata,
        charStart,
        charEnd
      }
    });

    if (end >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * 为 chunk 补齐文档内连续 index 和稳定 id。chunkIndex 从 0 开始，方便数组和检索结果对齐。
 *
 * @param chunk 待补齐身份字段的 chunk。
 * @param chunkIndex 文档内从 0 开始的连续序号。
 * @returns 带稳定 chunkId 的完整 chunk。
 */
function withChunkIdentity(chunk: FixedSizeChunkDraft, chunkIndex: number): RagChunk {
  const chunkId = `${chunk.documentId}_chunk_${String(chunkIndex).padStart(4, "0")}`;

  return {
    ...chunk,
    id: chunkId,
    chunkId,
    chunkIndex,
    metadata: {
      ...chunk.metadata,
      chunkIndex
    }
  };
}

/**
 * 返回数组中的第一个有效值，用于从 block 集合继承 page 或 heading。
 *
 * @param values 候选值数组。
 * @returns 第一个非空值。
 */
function firstDefined<TValue>(values: readonly (TValue | undefined)[]): TValue | undefined {
  return values.find((value): value is TValue => value !== undefined);
}

/**
 * 返回数组中的最后一个有效值，用于聚合整篇 fixed-size 文本的结束行号。
 *
 * @param values 候选值数组。
 * @returns 最后一个非空值。
 */
function lastDefined<TValue>(values: readonly (TValue | undefined)[]): TValue | undefined {
  return [...values].reverse().find((value): value is TValue => value !== undefined);
}

/**
 * 为文本生成固定维度 mock embedding。
 *
 * @param text 输入文本。
 * @param dimensions 输出向量维度。
 * @returns L2 normalize 后的稳定向量。
 */
function createDeterministicEmbeddingVector(text: string, dimensions: number): EmbeddingVector {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenizeForMockEmbedding(text);

  if (tokens.length === 0) {
    return vector;
  }

  tokens.forEach((token) => {
    const hash = stableHash(token);
    const dimension = hash % dimensions;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[dimension] += sign;
  });

  return normalizeVector(vector);
}

/**
 * 将文本规范化为 mock embedding token。
 *
 * @param text 输入文本。
 * @returns 小写英文/数字词和 CJK 字符 token，保证中英文样例都有可比较特征。
 */
function tokenizeForMockEmbedding(text: string): string[] {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjkChars = normalized.match(/[\u4e00-\u9fff]/g) ?? [];

  return [...words, ...cjkChars];
}

/**
 * 使用 FNV-1a 变体生成稳定 32-bit hash，避免依赖运行时随机种子。
 *
 * @param value 待 hash 字符串。
 * @returns 无符号整数 hash。
 */
function stableHash(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/**
 * L2 normalize 向量，便于 cosine similarity 稳定比较。
 *
 * @param vector 原始向量。
 * @returns 归一化向量；零向量保持不变。
 */
function normalizeVector(vector: readonly number[]): EmbeddingVector {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));

  if (norm === 0) {
    return [...vector];
  }

  return vector.map((value) => value / norm);
}

/**
 * 计算 cosine similarity。
 *
 * @param left 左向量。
 * @param right 右向量。
 * @returns 相似度分数；任一零向量返回 0。
 */
function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
  if (left.length !== right.length) {
    return 0;
  }

  const leftNorm = Math.sqrt(left.reduce((total, value) => total + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((total, value) => total + value * value, 0));

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  const dotProduct = left.reduce((total, value, index) => total + value * right[index], 0);

  return dotProduct / (leftNorm * rightNorm);
}

/**
 * 校验并限制 topK，避免调用方一次取回过多结果。
 *
 * @param topK 调用方请求的 topK。
 * @returns 合法时返回限制后的 topK，否则返回结构化错误。
 */
function normalizeTopK(
  topK: number | undefined
): { ok: true; topK: number } | { ok: false; error: RagStructuredError } {
  if (topK === undefined) {
    return {
      ok: true,
      topK: DEFAULT_VECTOR_SEARCH_TOP_K
    };
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    return {
      ok: false,
      error: {
        code: "invalid_vector_search_options",
        message: "topK 必须是大于 0 的整数。",
        details: {
          topK
        }
      }
    };
  }

  return {
    ok: true,
    topK: Math.min(topK, MAX_VECTOR_SEARCH_TOP_K)
  };
}

/**
 * 判断 chunk 是否满足向量检索 metadata filter。
 *
 * @param chunk 候选 chunk。
 * @param filter documentId/source 过滤条件。
 * @returns 满足条件时返回 true。
 */
function matchesVectorSearchFilter(
  chunk: EmbeddedChunk,
  filter: VectorSearchOptions["filter"]
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.documentId !== undefined && chunk.documentId !== filter.documentId) {
    return false;
  }

  if (filter.source !== undefined && chunk.source !== filter.source) {
    return false;
  }

  return true;
}
