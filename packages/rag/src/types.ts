import type {
  CitationDto,
  CitationSourceKindDto,
  DataSourceDocumentDto,
  DataSourceIngestRequestDto,
  DataSourceIngestResponseDto,
  EmbeddedChunkDto,
  EmbeddingUsageDto,
  IngestedDocumentDto,
  IngestedTextBlockDto,
  RagAnswerDto,
  RagChunkDto,
  RagDocumentDto,
  RetrievalResultDto,
  RetrievalScoreBreakdownDto,
  RetrievalTraceDto,
  VectorSearchMatchDto
} from "@aiagent/types";
import type { QueryRewriter } from "./query-rewrite.js";
import type { RagDocumentRepository, RagDocumentScope } from "./document-repository.js";
import type { KeywordCandidateStore } from "./keyword-store.js";
export type { KeywordCandidateStore } from "./keyword-store.js";

export type RagDocument = RagDocumentDto;

/**
 * 证据充分性阈值（前置修正 #1）：控制 synthesizeRagAnswer 把「可答」翻转为「拒答」的灵敏度，
 * 作为 DataSourceRuntimeOptions 的可注入点。两条判定通道可独立注入：
 * - minQueryTermCoverage：检索词覆盖率下限；
 * - minFinalScore：最终相关性分数下限。
 * 任一字段缺省时由 synthesizeRagAnswer 沿用内置常量（0.15 / 0.42）。
 */
export interface EvidenceSufficiencyThreshold {
  minQueryTermCoverage?: number;
  minFinalScore?: number;
}
export type RagChunk = RagChunkDto;
export type Citation = CitationDto;
export type RetrievalResult = RetrievalResultDto;
export type RetrievalScoreBreakdown = RetrievalScoreBreakdownDto;
export type RagAnswer = RagAnswerDto;
export type EmbeddedChunk = EmbeddedChunkDto;
export type EmbeddingUsage = EmbeddingUsageDto;
export type VectorSearchMatch = VectorSearchMatchDto;

/**
 * 检索候选/引用的来源类型：attachment（会话级临时附件）或 internal（内部知识库）。
 * 镜像 DTO 的 CitationSourceKindDto，保持 rag 内部领域类型与跨边界 DTO 命名一致。
 */
export type CitationSourceKind = CitationSourceKindDto;

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
    documentIds?: string[];
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
  /** 该候选来源：附件 / 内部知识库；缺省表示单源检索未标注来源。 */
  sourceKind?: CitationSourceKind;
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
    /** 该候选来源：附件 / 内部知识库；缺省表示未标注。 */
    sourceKind?: CitationSourceKind;
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
  trace: RetrievalTraceDto;
}

export interface RagAnswerRuntimeResponse {
  answer: RagAnswer;
  trace: RetrievalTraceDto;
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

/** search/answer 的调用身份；缺省匿名时只能检索 shared/demo。 */
export interface DataSourceRetrievalContext {
  ownerUserId?: string | null;
}

/**
 * DataSourceRuntime 封装 ingestion lineage 持久化、chunk、embedding、向量索引、retrieval 和 answer policy。
 *
 * 文档/版本/chunk 事实源是 RagDocumentRepository（PostgreSQL 或内存 adapter）；
 * VectorStore 由 composition root 注入；生产使用 PostgreSQL，单测/eval 显式使用内存 adapter。
 */
export interface DataSourceRuntime {
  ingest(
    request: DataSourceIngestRequestDto,
    context?: DataSourceIngestContext
  ): Promise<DataSourceRuntimeResult<DataSourceIngestResponseDto>>;
  listDocuments(options?: DataSourceListOptions): Promise<{ documents: DataSourceDocumentDto[]; nextCursor: string | null }>;
  listChunks(options?: DataSourceListChunksOptions): Promise<{ chunks: RagChunk[]; nextCursor: string | null }>;
  search(query: string, options?: RetrievalOptions, context?: DataSourceRetrievalContext): Promise<DataSourceRuntimeResult<RagSearchRuntimeResponse>>;
  answer(question: string, options?: RetrievalOptions, context?: DataSourceRetrievalContext): Promise<DataSourceRuntimeResult<RagAnswerRuntimeResponse>>;
}

/** Data Sources runtime 的 adapter 依赖。 */
export interface DataSourceRuntimeOptions {
  repository?: RagDocumentRepository;
  /**
   * embedding client 注入点；不提供生产默认值。
   * 生产组合根应通过 createEmbeddingClientFromEnv() 注入真实 client；该函数禁用时返回 null，
   * runtime 的 ingest/search/answer 会返回 `embedding_provider_disabled`，不会生成 mock 向量。
   * 单测如需确定性向量，必须显式注入 testing.ts 的 test double。
   */
  embeddingClient?: EmbeddingClient | null;
  vectorStoreFactory?: (ownerUserId: string | null) => VectorStore;
  /**
   * 外置关键词候选存储工厂（P3）：按 owner 绑定 Postgres 共享存储实现，使关键词召回跨实例一致。
   * 注入后 `retriever()` 不再把整库 chunks 载入进程内存做关键词扫描，而是直接从共享表读取候选；
   * 缺省 undefined 时退回内存语料路径（单测/本地 demo 退化，无 DATABASE_URL 场景）。
   * 与 vectorStoreFactory 同一按 owner 绑定范式，保证 private 文档仅 owner 可见。
   */
  keywordStoreFactory?: (ownerUserId: string | null) => KeywordCandidateStore;
  /**
   * 真实 Reranker（cross-encoder / LLM-judge）注入点；缺省（undefined 或 null）时
   * HybridRetriever 内部回退 HeuristicReranker。通过 createRerankerFromEnv() 在生产组合中注入，
   * 该函数禁用时返回 null，组合根应视为"未注入精排"。
   */
  reranker?: Reranker | null;
  /**
   * Contextual Retrieval 前缀注入器：ingest 时对 chunk 拼接文档级 LLM 上下文前缀后再 embedding。
   * 缺省（undefined 或 null）不注入（恒等）。通过 createContextEnricherFromEnv() 注入，禁用时返回 null。
   */
  contextEnricher?: ((document: IngestedDocumentDto, chunks: RagChunk[]) => Promise<RagChunk[]>) | null;
  /**
   * query 改写节点（Agentic 检索 / Self-RAG）：检索前把原始 query 改写为检索友好问句。
   * 缺省（undefined 或 null）不改写（恒等）。通过 createQueryRewriterFromEnv() 注入，禁用时返回 null。
   */
  queryRewriter?: QueryRewriter | null;
  /**
   * ingest 切块策略注入点（前置修正 #5）：覆盖默认 DEFAULT_CHUNKING_OPTIONS（heading_aware / 1200 / 150）。
   * 缺省 undefined 时 ingest 沿用默认切块行为，零回归；finance-api 等领域可在组合根注入不同窗口/重叠。
   */
  chunkingOptions?: ChunkingOptions;
  /**
   * 证据充分性阈值注入点（前置修正 #1）：覆盖 synthesizeRagAnswer 内置的 0.15 / 0.42 默认阈值。
   * 缺省 undefined 时 runtime 透传空对象，由 synthesizeRagAnswer 沿用内置常量，行为与原版一致。
   */
  evidenceSufficiencyThreshold?: EvidenceSufficiencyThreshold;
}

export interface HybridRetrieverOptions {
  embeddingClient: EmbeddingClient;
  vectorStore: VectorStore;
  /**
   * 内存关键词语料（仅当未注入 keywordStore 时使用）。
   * 注入外置 keywordStore 后本字段可空：关键词候选改从共享存储读取，跨实例一致，
   * 不再需要在进程内持有整库 chunks（P3）。
   */
  chunks?: readonly EmbeddedChunk[];
  reranker?: Reranker;
  /**
   * 外置关键词候选存储（P3）：注入后关键词召回从共享存储读取，跨实例一致。
   * 缺省 undefined 时退回内存扫描 `chunks`（单测/本地 demo 退化路径）。
   */
  keywordStore?: KeywordCandidateStore;
}

export interface RagStructuredError {
  code:
    | "invalid_chunking_options"
    | "chunking_failed"
    | "embedding_provider_disabled"
    | "invalid_embedding_input"
    | "embedding_failed"
    | "embedding_dimension_mismatch"
    | "embedding_model_mismatch"
    | "embedding_checksum_mismatch"
    | "invalid_vector_search_options"
    | "vector_store_dimension_mismatch"
    | "invalid_retrieval_options"
    | "retrieval_failed"
    | "ingestion_failed"
    | "indexing_failed"
    | "attachment_store_failed"
    | "invalid_attachment_scope"
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
export const RAG_PARSER_VERSION = "parsing-markdown-txt-v1";

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
