import type { IngestedFilingDocumentDto, FilingSourceKindDto } from "./filings.js";
import type { ISODateTimeString } from "./primitives.js";

/**
 * RAG 文档 DTO 表达可检索文档的稳定身份和来源，不包含全文。
 */
export interface RagDocumentDto {
  id: string;
  title: string;
  sourceUri: string;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * RAG chunk DTO 表达切分后的文本片段和来源位置，用于检索、引用和评测。
 */
export interface RagChunkDto {
  chunkId: string;
  id: string;
  documentId: string;
  source: string;
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

/**
 * Embedded chunk DTO 在 chunk 基础上增加向量和 embedding 模型信息，作为检索索引的跨边界数据形态。
 */
export interface EmbeddedChunkDto extends RagChunkDto {
  embedding: readonly number[];
  embeddingModel: string;
}

/**
 * Embedding usage DTO 记录本次 mock 或真实 provider 调用的输入规模，后续可扩展为 token 成本统计。
 */
export interface EmbeddingUsageDto {
  inputTexts: number;
  inputCharacters: number;
}

/**
 * 向量检索命中 DTO 保存完整 chunk、相似度分数和排序，便于 API/UI 展示证据。
 */
export interface VectorSearchMatchDto {
  chunk: EmbeddedChunkDto;
  score: number;
  rank: number;
}

/**
 * 检索 score breakdown DTO 暴露向量、关键词、rerank 与最终分数，便于 UI 和 trace 解释排序原因。
 */
export interface RetrievalScoreBreakdownDto {
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
  rerankScore?: number;
  finalScore: number;
  vectorWeight: number;
  keywordWeight: number;
  matchedTerms: string[];
  queryTermCoverage: number;
  headingMatch: boolean;
}

/**
 * 引用 DTO 连接回答片段和原始 chunk，是 grounded answer 的最小证据结构。
 */
export interface CitationDto {
  chunkId: string;
  documentId: string;
  source: string;
  heading?: string;
  chunkIndex: number;
  quote: string;
  pageNumber?: number;
  confidence: number;
}

/**
 * 检索结果 DTO 保存 chunk 文本、分数和可直接展示的引用信息。
 */
export interface RetrievalResultDto {
  chunkId: string;
  documentId: string;
  score: number;
  rank?: number;
  text: string;
  scoreBreakdown?: RetrievalScoreBreakdownDto;
  citation: CitationDto;
}

/**
 * RAG answer DTO 是 API 返回给 UI 的 grounded answer 合同。
 */
export interface RagAnswerDto {
  answer: string;
  citations: CitationDto[];
  retrievalResults: RetrievalResultDto[];
}

/**
 * Data Sources ingestion 请求 DTO，API adapter 负责校验后交给 RAG runtime。
 */
export interface DataSourceIngestRequestDto {
  source: string;
  fileName: string;
  contentType?: string;
  content: string;
}

/** Composer 文件上传请求；clientAttachmentId 让网络重试保持同一逻辑文档。 */
export interface ChatAttachmentUploadRequestDto {
  clientAttachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  content: string;
}

/** 上传完成后的草稿附件，发送消息时通过 documentId 绑定。 */
export interface ChatAttachmentDto {
  documentId: string;
  clientAttachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "indexed";
}

/**
 * RAG 文档可见范围 DTO：private 仅 owner 可见，shared/demo 对所有调用方可见。
 */
export type RagDocumentScopeDto = "private" | "shared" | "demo";

/**
 * RAG 文档版本状态 DTO：failed 为终态但允许同内容重试。
 */
export type RagDocumentVersionStatusDto = "pending" | "indexed" | "failed";

/**
 * Data Sources 文档摘要 DTO，表达持久化文档身份、最新版本状态和来源，不包含全文。
 */
export interface DataSourceDocumentDto {
  documentId: string;
  title: string;
  scope: RagDocumentScopeDto;
  sourceType: FilingSourceKindDto;
  externalId: string;
  sourceUri: string;
  latestVersion: number;
  latestStatus: RagDocumentVersionStatusDto;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

/**
 * Data Sources ingestion 响应 DTO，展示文档、版本号、幂等命中标记和本次入库 chunk 数量。
 */
export interface DataSourceIngestResponseDto {
  document: IngestedFilingDocumentDto;
  chunks: RagChunkDto[];
  indexedChunkCount: number;
  documentVersion: number;
  deduplicated: boolean;
}

/**
 * Data Sources 文档列表响应 DTO，使用稳定 cursor 分页。
 */
export interface DataSourceDocumentsResponseDto {
  documents: DataSourceDocumentDto[];
  nextCursor: string | null;
}

/**
 * Data Sources chunk 列表响应 DTO，使用稳定 cursor 分页。
 */
export interface DataSourceChunksResponseDto {
  chunks: RagChunkDto[];
  nextCursor: string | null;
}

/**
 * RAG search 请求 DTO。
 */
export interface RagSearchRequestDto {
  query: string;
  topK?: number;
}

/**
 * RAG 检索 trace DTO：阶段 6 从 trace.ts 迁移到 rag.ts，
 * 作为检索结果公开 API 的一部分，不再依赖旧 trace 事件体系。
 */
export interface RetrievalTraceDto {
  type: "retrieval";
  id: string;
  traceId: string;
  requestId: string;
  createdAt: ISODateTimeString;
  queryPreview: string;
  mode: "vector" | "keyword" | "hybrid";
  topK: number;
  candidateLimit: number;
  durationMs: number;
  chunkIds: string[];
  scoreSummary: Array<{
    chunkId: string;
    documentId?: string;
    vectorScore: number;
    keywordScore: number;
    hybridScore: number;
    rerankScore?: number;
    finalScore: number;
    rank: number;
  }>;
  ok: boolean;
  error?: {
    code: string;
    message: string;
    stage?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * RAG search 响应 DTO，包含可展示结果和脱敏检索 trace。
 */
export interface RagSearchResponseDto {
  results: RetrievalResultDto[];
  trace: RetrievalTraceDto;
}

/**
 * RAG answer 请求 DTO。
 */
export interface RagAnswerRequestDto {
  question: string;
  topK?: number;
}

/**
 * RAG answer 响应 DTO，answer 内含 citations，trace 用于解释召回。
 */
export interface RagAnswerResponseDto {
  answer: RagAnswerDto;
  trace: RetrievalTraceDto;
}
