/**
 * RAG 包测试替身（test double）集中地。
 *
 * v1.1 改造后，所有 `fromEnv` 工厂在环境变量缺失/禁用时返回 `null`（不再静默回退到 mock），
 * 因此原先的"生产默认 mock"——deterministic embedding、noop enricher、noop rewriter——
 * 被降级为 **仅供测试显式注入** 的 test double，移出生产模块，避免被误用为生产默认值。
 *
 * 生产代码如需可复现 embedding / 恒等增强 / 原样改写，应在测试中 import 本文件并手动注入；
 * 各原生产模块（embedding.ts / contextual-retrieval.ts / query-rewrite.ts）继续 re-export 这些名字，
 * 以保持历史导入路径不变。
 */

import type { IngestedDocumentDto } from "@aiagent/types";
import {
  DEFAULT_MOCK_EMBEDDING_DIMENSIONS,
  DEFAULT_MOCK_EMBEDDING_MODEL,
  type DeterministicMockEmbeddingClientOptions,
  type EmbeddingClient,
  type EmbeddingResult
} from "./types.js";
import { createDeterministicEmbeddingVector } from "./vector-math.js";
import type { RagChunk } from "./types.js";
import type { QueryRewriter, QueryRewriteResult } from "./query-rewrite.js";

/**
 * 创建 deterministic mock embedding client（测试替身，复刻旧生产默认实现）。
 *
 * 通过规范化 token、稳定 hash 和 L2 normalize 生成固定维度向量，使同一文本每次输出完全一致；
 * 这能先验证索引、检索和错误边界，避免把真实 embedding provider 的网络变量混入单测。
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
 * deterministic mock embedding 的运行时实现（测试替身）。
 *
 * 通过规范化 token、稳定 hash 和 L2 normalize 生成固定维度向量，使同一文本每次输出完全一致；
 * 这能先验证索引、检索和错误边界，避免把真实 embedding provider 的网络变量混入单测。
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
 * 创建恒等 enricher（测试 baseline）：原样返回 chunks，等价于"未注入任何上下文前缀"。
 *
 * @returns 不改变任何 chunk 的 enricher。
 */
export function createNoopContextualEnricher(): (
  document: IngestedDocumentDto,
  chunks: RagChunk[]
) => Promise<RagChunk[]> {
  return async (_document, chunks) => chunks;
}

/**
 * 创建原样 rewriter（测试 baseline / 关闭增强时使用）：永远返回原 query。
 *
 * @returns 永远返回原 query 的 rewriter。
 */
export function createNoopQueryRewriter(): QueryRewriter {
  return async (query: string): Promise<QueryRewriteResult> => ({ rewritten: query });
}
