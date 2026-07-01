import type {
  CitationDto,
  IngestedFilingDocumentDto,
  IngestedTextBlockDto,
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

export type ChunkingStrategy = "fixed_size" | "heading_aware";

export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxChars: number;
  overlapChars: number;
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
  code:
    | "invalid_chunking_options"
    | "chunking_failed"
    | "embedding_failed"
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
  runtimeState: "chunking_ready";
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  strategy: "heading_aware",
  maxChars: 1200,
  overlapChars: 150
};

/**
 * 创建 RAG package 的边界摘要，明确本阶段只提供骨架和稳定类型。
 *
 * @returns RAG package 的职责边界和当前实现状态。
 */
export function createRagPackageSummary(): RagPackageSummary {
  return {
    packageName: "@aiagent/rag",
    boundary: "chunking_embedding_retrieval_citation_answer",
    runtimeState: "chunking_ready"
  };
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
