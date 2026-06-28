import type {
  CitationDto,
  RagAnswerDto,
  RagChunkDto,
  RagDocumentDto,
  RetrievalResultDto
} from "@aiagent/types";

export type RagDocument = RagDocumentDto;
export type RagChunk = RagChunkDto;
export type Citation = CitationDto;
export type RetrievalResult = RetrievalResultDto;
export type RagAnswer = RagAnswerDto;

export type EmbeddingVector = readonly number[];

export interface ChunkingOptions {
  maxTokens: number;
  overlapTokens: number;
}

export interface EmbeddingInput {
  chunkId: string;
  text: string;
}

export interface EmbeddingResult {
  chunkId: string;
  vector: EmbeddingVector;
  model: string;
}

export interface RagStructuredError {
  code: "chunking_failed" | "embedding_failed" | "retrieval_failed" | "answer_failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface RagPackageSummary {
  packageName: "@aiagent/rag";
  boundary: "chunking_embedding_retrieval_citation_answer";
  runtimeState: "types_and_mock_only";
}

/**
 * 创建 RAG package 的边界摘要，明确本阶段只提供骨架和稳定类型。
 *
 * @returns RAG package 的职责边界和当前实现状态。
 */
export function createRagPackageSummary(): RagPackageSummary {
  return {
    packageName: "@aiagent/rag",
    boundary: "chunking_embedding_retrieval_citation_answer",
    runtimeState: "types_and_mock_only"
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
