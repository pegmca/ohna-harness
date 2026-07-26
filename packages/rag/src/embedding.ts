import {
  DEFAULT_MOCK_EMBEDDING_DIMENSIONS,
  DEFAULT_MOCK_EMBEDDING_MODEL,
  type DeterministicMockEmbeddingClientOptions,
  type EmbeddingClient,
  type EmbeddingResult
} from "./types.js";
import { createDeterministicEmbeddingVector } from "./vector-math.js";

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
