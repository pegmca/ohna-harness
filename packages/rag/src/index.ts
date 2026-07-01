import type {
  CitationDto,
  EmbeddedChunkDto,
  EmbeddingUsageDto,
  IngestedFilingDocumentDto,
  IngestedTextBlockDto,
  RagAnswerDto,
  RagChunkDto,
  RagDocumentDto,
  RetrievalResultDto,
  VectorSearchMatchDto
} from "@aiagent/types";

export type RagDocument = RagDocumentDto;
export type RagChunk = RagChunkDto;
export type Citation = CitationDto;
export type RetrievalResult = RetrievalResultDto;
export type RagAnswer = RagAnswerDto;
export type EmbeddedChunk = EmbeddedChunkDto;
export type EmbeddingUsage = EmbeddingUsageDto;
export type VectorSearchMatch = VectorSearchMatchDto;

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

export interface RagStructuredError {
  code:
    | "invalid_chunking_options"
    | "chunking_failed"
    | "invalid_embedding_input"
    | "embedding_failed"
    | "embedding_dimension_mismatch"
    | "invalid_vector_search_options"
    | "vector_store_dimension_mismatch"
    | "retrieval_failed"
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
  runtimeState: "embedding_vector_store_ready";
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  strategy: "heading_aware",
  maxChars: 1200,
  overlapChars: 150
};

export const DEFAULT_MOCK_EMBEDDING_MODEL = "deterministic-mock-embedding-v1";
export const DEFAULT_MOCK_EMBEDDING_DIMENSIONS = 32;
export const DEFAULT_VECTOR_SEARCH_TOP_K = 5;
export const MAX_VECTOR_SEARCH_TOP_K = 50;

/**
 * 创建 RAG package 的边界摘要，明确本阶段只提供骨架和稳定类型。
 *
 * @returns RAG package 的职责边界和当前实现状态。
 */
export function createRagPackageSummary(): RagPackageSummary {
  return {
    packageName: "@aiagent/rag",
    boundary: "chunking_embedding_retrieval_citation_answer",
    runtimeState: "embedding_vector_store_ready"
  };
}

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

/**
 * 将 ingestion 文档切分为可检索 chunk。
 *
 * @param document filings package 输出的结构化文档，包含 blocks、source 和 documentId。
 * @param options chunk 策略配置；默认使用 heading-aware 以保留公告章节线索。
 * @returns 成功时返回连续 chunkIndex 的 chunks，配置非法时返回结构化错误。
 */
export function chunkIngestedFilingDocument(
  document: IngestedFilingDocumentDto,
  options: ChunkingOptions = DEFAULT_CHUNKING_OPTIONS
): ChunkingResult {
  return chunkDocumentBlocks(
    {
      documentId: document.documentId,
      source: document.source,
      blocks: document.blocks
    },
    options
  );
}

/**
 * 将 ingestion blocks 切分为 chunk。
 *
 * fixed-size 适合没有结构的 TXT 或长文本，行为稳定但可能切断语义段落。
 * heading-aware 优先保留 Markdown/公告解析得到的 heading，便于后续 citation 显示章节；
 * 当单个 block 超过 maxChars 时仍回退到 fixed-size，避免生成过大的不可控 chunk。
 *
 * @param input 文档身份、来源和 ingestion block 列表。
 * @param options chunk 策略配置。
 * @returns chunking 结果，空 blocks 或空文本会返回空 chunks。
 */
export function chunkDocumentBlocks(
  input: ChunkBlocksInput,
  options: ChunkingOptions = DEFAULT_CHUNKING_OPTIONS
): ChunkingResult {
  const validationError = validateChunkingOptions(options);

  if (validationError) {
    return {
      ok: false,
      error: validationError
    };
  }

  const chunks: RagChunk[] = [];

  if (options.strategy === "fixed_size") {
    const text = input.blocks.map((block) => block.text).join("\n\n");
    const result = createFixedSizeChunks({
      documentId: input.documentId,
      source: input.source,
      text,
      baseCharStart: 0,
      heading: firstDefined(input.blocks.map((block) => block.heading)),
      page: firstDefined(input.blocks.map((block) => block.pageNumber)),
      metadata: {
        strategy: "fixed_size",
        blockIds: input.blocks.map((block) => block.id).join(","),
        lineStart: firstDefined(input.blocks.map((block) => block.lineStart)) ?? null,
        lineEnd: lastDefined(input.blocks.map((block) => block.lineEnd)) ?? null
      },
      options
    });

    chunks.push(...result);
  } else {
    let baseCharStart = 0;

    input.blocks.forEach((block) => {
      const blockText = block.text.trim();
      const blockCharStart = baseCharStart;
      baseCharStart += block.text.length + 2;

      if (blockText.length === 0) {
        return;
      }

      chunks.push(
        ...createFixedSizeChunks({
          documentId: input.documentId,
          source: input.source,
          text: blockText,
          baseCharStart: blockCharStart,
          heading: block.heading,
          page: block.pageNumber,
          metadata: {
            strategy: "heading_aware",
            blockId: block.id,
            lineStart: block.lineStart,
            lineEnd: block.lineEnd,
            pageNumber: block.pageNumber ?? null,
            heading: block.heading ?? null,
            ...block.metadata
          },
          options
        })
      );
    });
  }

  return {
    ok: true,
    chunks: chunks.map((chunk, chunkIndex) => withChunkIdentity(chunk, chunkIndex))
  };
}

/**
 * 直接切分一段纯文本，便于单元测试和后续非 filings 来源复用。
 *
 * @param input 文档身份、来源、文本和可选来源位置。
 * @param options chunk 策略配置。
 * @returns chunking 结果；空文本返回空 chunks。
 */
export function chunkText(
  input: ChunkTextInput,
  options: ChunkingOptions = {
    ...DEFAULT_CHUNKING_OPTIONS,
    strategy: "fixed_size"
  }
): ChunkingResult {
  const validationError = validateChunkingOptions(options);

  if (validationError) {
    return {
      ok: false,
      error: validationError
    };
  }

  const text = input.text.trim();

  if (text.length === 0) {
    return {
      ok: true,
      chunks: []
    };
  }

  return {
    ok: true,
    chunks: createFixedSizeChunks({
      documentId: input.documentId,
      source: input.source,
      text,
      baseCharStart: 0,
      heading: input.heading,
      page: input.page,
      metadata: {
        strategy: options.strategy,
        lineStart: input.lineStart ?? null,
        lineEnd: input.lineEnd ?? null,
        heading: input.heading ?? null,
        ...input.metadata
      },
      options
    }).map((chunk, chunkIndex) => withChunkIdentity(chunk, chunkIndex))
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

interface FixedSizeChunkDraft {
  documentId: string;
  source: string;
  id: string;
  chunkId: string;
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

interface FixedSizeInput {
  documentId: string;
  source: string;
  text: string;
  baseCharStart: number;
  heading?: string;
  page?: number;
  metadata: Record<string, string | number | boolean | null>;
  options: ChunkingOptions;
}

/**
 * 校验 chunk 参数，尤其防止 overlap 大于等于窗口导致游标不前进。
 *
 * @param options 调用方传入的 chunk 配置。
 * @returns 配置合法时返回 undefined，否则返回结构化错误。
 */
function validateChunkingOptions(options: ChunkingOptions): RagStructuredError | undefined {
  if (options.strategy !== "fixed_size" && options.strategy !== "heading_aware") {
    return {
      code: "invalid_chunking_options",
      message: "chunk 策略必须是 fixed_size 或 heading_aware。",
      details: {
        strategy: options.strategy
      }
    };
  }

  if (!Number.isInteger(options.maxChars) || options.maxChars <= 0) {
    return {
      code: "invalid_chunking_options",
      message: "maxChars 必须是大于 0 的整数。",
      details: {
        maxChars: options.maxChars
      }
    };
  }

  if (!Number.isInteger(options.overlapChars) || options.overlapChars < 0) {
    return {
      code: "invalid_chunking_options",
      message: "overlapChars 必须是大于等于 0 的整数。",
      details: {
        overlapChars: options.overlapChars
      }
    };
  }

  if (options.overlapChars >= options.maxChars) {
    return {
      code: "invalid_chunking_options",
      message: "overlapChars 必须小于 maxChars，避免 chunk 游标无法前进。",
      details: {
        maxChars: options.maxChars,
        overlapChars: options.overlapChars
      }
    };
  }

  return undefined;
}

/**
 * 按字符窗口切分文本，并用 overlap 保留相邻 chunk 的上下文。
 *
 * @param input 已校验配置和来源信息。
 * @returns 未补齐最终 chunkIndex 的 chunk 草稿。
 */
function createFixedSizeChunks(input: FixedSizeInput): FixedSizeChunkDraft[] {
  const text = input.text.trim();

  if (text.length === 0) {
    return [];
  }

  const chunks: FixedSizeChunkDraft[] = [];
  const step = input.options.maxChars - input.options.overlapChars;

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + input.options.maxChars, text.length);
    const chunkText = text.slice(start, end);
    const charStart = input.baseCharStart + start;
    const charEnd = input.baseCharStart + end;

    chunks.push({
      documentId: input.documentId,
      source: input.source,
      id: "",
      chunkId: "",
      chunkIndex: -1,
      text: chunkText,
      charStart,
      charEnd,
      startOffset: charStart,
      endOffset: charEnd,
      page: input.page,
      pageNumber: input.page,
      heading: input.heading,
      metadata: {
        ...input.metadata,
        charStart,
        charEnd
      }
    });

    if (end >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * 为 chunk 补齐文档内连续 index 和稳定 id。chunkIndex 从 0 开始，方便数组和检索结果对齐。
 *
 * @param chunk 待补齐身份字段的 chunk。
 * @param chunkIndex 文档内从 0 开始的连续序号。
 * @returns 带稳定 chunkId 的完整 chunk。
 */
function withChunkIdentity(chunk: FixedSizeChunkDraft, chunkIndex: number): RagChunk {
  const chunkId = `${chunk.documentId}_chunk_${String(chunkIndex).padStart(4, "0")}`;

  return {
    ...chunk,
    id: chunkId,
    chunkId,
    chunkIndex,
    metadata: {
      ...chunk.metadata,
      chunkIndex
    }
  };
}

/**
 * 返回数组中的第一个有效值，用于从 block 集合继承 page 或 heading。
 *
 * @param values 候选值数组。
 * @returns 第一个非空值。
 */
function firstDefined<TValue>(values: readonly (TValue | undefined)[]): TValue | undefined {
  return values.find((value): value is TValue => value !== undefined);
}

/**
 * 返回数组中的最后一个有效值，用于聚合整篇 fixed-size 文本的结束行号。
 *
 * @param values 候选值数组。
 * @returns 最后一个非空值。
 */
function lastDefined<TValue>(values: readonly (TValue | undefined)[]): TValue | undefined {
  return [...values].reverse().find((value): value is TValue => value !== undefined);
}

/**
 * 为文本生成固定维度 mock embedding。
 *
 * @param text 输入文本。
 * @param dimensions 输出向量维度。
 * @returns L2 normalize 后的稳定向量。
 */
function createDeterministicEmbeddingVector(text: string, dimensions: number): EmbeddingVector {
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
function tokenizeForMockEmbedding(text: string): string[] {
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
function stableHash(value: string): number {
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
function normalizeVector(vector: readonly number[]): EmbeddingVector {
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
function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
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
function normalizeTopK(
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
function matchesVectorSearchFilter(
  chunk: EmbeddedChunk,
  filter: VectorSearchOptions["filter"]
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.documentId !== undefined && chunk.documentId !== filter.documentId) {
    return false;
  }

  if (filter.source !== undefined && chunk.source !== filter.source) {
    return false;
  }

  return true;
}
