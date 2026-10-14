// 生产 embedding client 在 embedding-providers.ts；deterministic mock 已降级为 testing.ts 的测试替身。
// 这里仅为保持历史公共 API re-export；生产组合不得调用，测试应优先从 testing.js 显式导入。

export { createDeterministicMockEmbeddingClient } from "./testing.js";
