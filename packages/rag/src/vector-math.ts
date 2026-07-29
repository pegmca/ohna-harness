import {
  DEFAULT_VECTOR_SEARCH_TOP_K,
  MAX_VECTOR_SEARCH_TOP_K,
  type EmbeddedChunk,
  type EmbeddingVector,
  type RagStructuredError,
  type VectorSearchOptions
} from "./types.js";

/**
 * 为文本生成固定维度 mock embedding。
 *
 * @param text 输入文本。
 * @param dimensions 输出向量维度。
 * @returns L2 normalize 后的稳定向量。
 */
export function createDeterministicEmbeddingVector(text: string, dimensions: number): EmbeddingVector {
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
export function tokenizeForMockEmbedding(text: string): string[] {
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
export function stableHash(value: string): number {
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
export function normalizeVector(vector: readonly number[]): EmbeddingVector {
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
export function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
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
export function normalizeTopK(
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
export function matchesVectorSearchFilter(
  chunk: EmbeddedChunk,
  filter: VectorSearchOptions["filter"]
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.documentId !== undefined && chunk.documentId !== filter.documentId) {
    return false;
  }

  if (filter.documentIds !== undefined && !filter.documentIds.includes(chunk.documentId)) {
    return false;
  }

  if (filter.source !== undefined && chunk.source !== filter.source) {
    return false;
  }

  return true;
}
