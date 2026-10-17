export {
  canTransitionCitationVerifierStatus
} from "./citation-repository.js";
export type {
  AccessibleCitationSource,
  CitationRecord,
  CitationRepository,
  CitationSourceProjection,
  CitationVerifierStatus,
  CitationVerifierUpdateResult,
  InaccessibleCitationSource,
  NewCitationInput,
  UnresolvedCitationSource
} from "./citation-repository.js";
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

export {
  PROVIDER_ENV,
  readLlmProviderConfig,
  readEmbeddingProviderConfig,
  readRerankProviderConfig,
  readJudgeProviderConfig,
  DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS
} from "./provider-config.js";
export * from "./types.js";
export * from "./vector-math.js";
// 以下模块为保持历史公共 API 仍 re-export testing.ts 的 deterministic/noop 替身；
// 它们只供测试显式注入，生产组合必须调用对应的 fromEnv 工厂，禁止把 test double 当默认实现。
export * from "./embedding.js";
export * from "./embedding-providers.js";
export * from "./vector-store.js";
export * from "./retrieval.js";
export * from "./keyword-store.js";
export * from "./reranking-providers.js";
export * from "./chunking.js";
export * from "./answer.js";
export * from "./source-uri.js";
export * from "./contextual-retrieval.js";
export * from "./query-rewrite.js";
export * from "./data-source-runtime.js";
// 会话级临时附件：AttachmentStore 抽象 + 内存实现、ingest、单源附件检索、多路召回编排。
export * from "./attachment-store.js";
export * from "./attachment-ingest.js";
export * from "./attachment-retriever.js";
export * from "./multi-source-retriever.js";
export {
  createGroundingTransformContext
} from "./grounding-hook.js";
export type {
  GroundingHookOptions,
  GroundingTransformContext
} from "./grounding-hook.js";
