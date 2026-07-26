import {
  type EmbeddedChunk,
  type EmbeddingVector,
  type RagStructuredError,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  type VectorStoreResult
} from "./types.js";
import { cosineSimilarity, matchesVectorSearchFilter, normalizeTopK } from "./vector-math.js";

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
 * 创建按 owner 复用的内存 VectorStore factory。
 *
 * 该 factory 仅供单测/eval/MCP 显式选择，保证 ingest 与后续 search 使用同一实例；
 * owner 分桶避免不同私有用户的内存向量候选互串。
 *
 * @returns 可注入 DataSource runtime 的 owner-bound factory。
 */
export function createInMemoryVectorStoreFactory(): (ownerUserId: string | null) => VectorStore {
  const stores = new Map<string, VectorStore>();
  return (ownerUserId) => {
    const key = ownerUserId ?? "__shared_demo__";
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createInMemoryVectorStore();
    stores.set(key, created);
    return created;
  };
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
