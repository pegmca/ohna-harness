/**
 * @aiagent/memory 公共出口：三层记忆（短期/长期/语义）的独立包。
 * 不依赖 @aiagent/agent，通过结构最小类型与 AgentLoopConfig 钩子对接。
 */

// 核心类型
export type {
  AgentContextLike,
  AgentToolResultLike,
  EpisodeId,
  EpisodeMemory,
  EpisodeType,
  MemoryAfterToolCallContext,
  MemoryBudgetSettings,
  MemoryPrepareNextTurnContext,
  MemoryStore,
  RetrievedMemory,
  WorkingMemory,
  WorkingMemoryFact,
} from "./types.js";
export { DEFAULT_MEMORY_BUDGET } from "./types.js";

// 本地相似度（语义检索的零依赖替代）
export { cosineSimilarity, jaccardSimilarity, tokenize } from "./similarity.js";

// 存储实现与工厂
export { InMemoryMemoryStore } from "./in-memory-store.js";
export { JsonlMemoryStore, type JsonlMemoryStoreOptions } from "./jsonl-store.js";
export {
  PgVectorMemoryStore,
  type PgVectorMemoryStoreOptions,
  type QueryExecutor,
  type Embedder,
  type DeterministicEmbedder,
  createDeterministicEmbedder,
  MEMORY_VECTOR_DIMENSIONS,
} from "./pg-vector-store.js";
export { createMemoryStore, type CreateMemoryStoreOptions } from "./store-factory.js";

// Hook 工厂
export {
  createMemoryRetrieveHook,
  createMemoryWriteHook,
  type MemoryRetrieveHookOptions,
  type MemoryWriteHookOptions,
} from "./hooks.js";
