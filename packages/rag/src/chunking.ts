import type { IngestedDocumentDto } from "@aiagent/types";
import type { IngestedTextBlockDto } from "@aiagent/types";
import {
  DEFAULT_CHUNKING_OPTIONS,
  type ChunkBlocksInput,
  type ChunkingOptions,
  type ChunkingResult,
  type ChunkTextInput,
  type RagChunk,
  type RagStructuredError
} from "./types.js";

/**
 * 将 ingestion 文档切分为可检索 chunk。
 *
 * @param document parsing package 输出的结构化文档，包含 blocks、source 和 documentId。
 * @param options chunk 策略配置；默认使用 heading-aware 以保留公告章节线索。
 * @returns 成功时返回连续 chunkIndex 的 chunks，配置非法时返回结构化错误。
 */
export function chunkIngestedDocument(
  document: IngestedDocumentDto,
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
  } else if (options.strategy === "heading_aware") {
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
  } else {
    chunks.push(...createTableAwareChunks(input, options));
  }

  return {
    ok: true,
    chunks: chunks.map((chunk, chunkIndex) => withChunkIdentity(chunk, chunkIndex))
  };
}

/**
 * 直接切分一段纯文本，便于单元测试和后续非 parsing 来源复用。
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

/** table_aware 聚合后的表组。 */
interface TableGroupDraft {
  rows: IngestedTextBlockDto[];
  header?: string;
  heading?: string;
  pageStart?: number;
  pageEnd?: number;
}

/**
 * table_aware：连续表行聚合成整表 chunk，并生成共享 tableGroupId 的 summary sibling。
 *
 * @param input 文档身份与 blocks。
 * @param options 已校验切块配置。
 * @returns 未补 chunkIndex 的整表与 summary chunk。
 */
function createTableAwareChunks(input: ChunkBlocksInput, options: ChunkingOptions): FixedSizeChunkDraft[] {
  const chunks: FixedSizeChunkDraft[] = [];
  const groups: TableGroupDraft[] = [];
  let current: TableGroupDraft | undefined;
  let latestHeading: string | undefined;
  let baseCharStart = 0;

  const finishGroup = (): void => {
    if (current && current.rows.length > 0) groups.push(current);
    current = undefined;
  };

  input.blocks.forEach((block) => {
    const text = block.text.trim();
    const blockCharStart = baseCharStart;
    baseCharStart += block.text.length + 2;

    if (block.heading) latestHeading = block.heading;

    if (block.metadata?.isTableRow === true) {
      if (!current) {
        current = { rows: [], heading: latestHeading };
      }
      current.rows.push(block);
      const page = block.pageNumber;
      if (page !== undefined) {
        current.pageStart ??= page;
        current.pageEnd = page;
      }
      const isHeaderCandidate = !isNumericDataRow(text);
      if (isHeaderCandidate) {
        current.header ??= text;
      }
      return;
    }

    if (current && block.heading === undefined && isTableContinuationBlock(block, options.tableHeaderFooterMaxChars ?? 80)) {
      return;
    }
    finishGroup();

    if (text.length === 0) return;
    chunks.push(
      ...createFixedSizeChunks({
        documentId: input.documentId,
        source: input.source,
        text,
        baseCharStart: blockCharStart,
        heading: block.heading,
        page: block.pageNumber,
        metadata: {
          strategy: "table_aware",
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
  finishGroup();

  groups.forEach((group, groupIndex) => {
    const tableGroupId = `${input.documentId}_table_${String(groupIndex).padStart(4, "0")}`;
    const rows = group.rows;
    const fullText = rows.map((row) => row.text.trim()).join("\n");
    const header = group.header ?? "";
    const rowKeys = rows
      .filter((row) => row.text.trim() !== header)
      .map((row) => splitTableCells(row.text)[0]?.trim())
      .filter((value): value is string => Boolean(value));
    const pageStart = group.pageStart ?? rows[0]?.pageNumber;
    const pageEnd = group.pageEnd ?? rows.at(-1)?.pageNumber;
    const commonMetadata: Record<string, string | number | boolean | null> = {
      strategy: "table_aware",
      tableGroupId,
      tableColumnCount: debouncedColumnCount(rows),
      tableRowCount: rows.length,
      tableHeader: header,
      tableHeading: group.heading ?? null,
      pageStart: pageStart ?? null,
      pageEnd: pageEnd ?? null,
      lineStart: rows[0]?.lineStart ?? null,
      lineEnd: rows.at(-1)?.lineEnd ?? null
    };
    const tableText = fullText;

    chunks.push({
      documentId: input.documentId,
      source: input.source,
      id: "",
      chunkId: "",
      chunkIndex: -1,
      text: tableText,
      charStart: 0,
      charEnd: tableText.length,
      startOffset: 0,
      endOffset: tableText.length,
      page: pageStart,
      pageNumber: pageStart,
      heading: group.heading,
      metadata: { ...commonMetadata, isTableChunk: true }
    });

    const summaryText = [
      `${header}`,
      `行数：${rows.length} 行`,
      `首列：${[...new Set(rowKeys)].join("、")}`
    ].join("\n");
    chunks.push({
      documentId: input.documentId,
      source: input.source,
      id: "",
      chunkId: "",
      chunkIndex: -1,
      text: summaryText,
      charStart: 0,
      charEnd: summaryText.length,
      startOffset: 0,
      endOffset: summaryText.length,
      page: pageStart,
      pageNumber: pageStart,
      heading: group.heading,
      metadata: { ...commonMetadata, isTableSummary: true }
    });
  });

  return chunks;
}

/**
 * 判断非表行是否是可忽略的页眉/页脚，以保持跨页表组连续。
 *
 * @param block 非表行 block。
 * @param maxChars 豁免文本长度上限。
 * @returns 是否粘在表组内但不进入表文。
 */
function isTableContinuationBlock(block: IngestedTextBlockDto, maxChars: number): boolean {
  const text = block.text.trim();
  if (block.metadata?.blockRole === "heading" || block.metadata?.isHeading === true || block.heading !== undefined) {
    return false;
  }
  if (text.length > maxChars || text.includes("\n")) return false;

  return /(?:公司|股份|年度报告|半年度报告|季度报告|第\s*\d+\s*页|\d+\s*\/\s*\d+)/.test(text);
}

/**
 * 按稳定间隔拆分表格行；U+3000 与两处以上空格都视为列分隔。
 *
 * @param text 表行文本。
 * @returns 单元格文本。
 */
function splitTableCells(text: string): string[] {
  return text.split(/[ \t]{2,}|\u3000+/).filter((cell) => cell.trim().length > 0);
}

/**
 * 使用列数中位数估算整表列数；少于三列的行视为稀疏抵减行，不参与中位数。
 *
 * @param rows 表行 blocks。
 * @returns 去抖后的列数。
 */
function debouncedColumnCount(rows: readonly IngestedTextBlockDto[]): number {
  const counts = rows
    .filter((row) => !isSparseDeductionRow(row))
    .map((row) => Number(row.metadata?.tableColumnCount ?? splitTableCells(row.text).length))
    .filter((count) => Number.isInteger(count) && count >= 3)
    .sort((left, right) => left - right);

  if (counts.length === 0) {
    const fallback = rows.map((row) => Number(row.metadata?.tableColumnCount ?? splitTableCells(row.text).length));
    return fallback.sort((left, right) => left - right)[Math.floor(fallback.length / 2)] ?? 0;
  }

  return counts[Math.floor(counts.length / 2)];
}

/**
 * 识别稀疏抵减行；这类行列数少于主表，不能拉低整表列数中位数。
 *
 * @param row 表行 block。
 * @returns 是否属于明细抵减行。
 */
function isSparseDeductionRow(row: IngestedTextBlockDto): boolean {
  return /^(?:其中|减[：:]|加[：:])/.test(row.text.trim());
}

/**
 * 判断一行是否已是数值数据行，避免把首个数据行误当表头。
 *
 * @param text 表行文本。
 * @returns 是否含可识别的数值单元格。
 */
function isNumericDataRow(text: string): boolean {
  return splitTableCells(text).slice(1).some((cell) => /^[\s(（+\-]?[\d,.%（）()]+[\s)）]?$/.test(cell.trim()));
}

/**
 * 校验 chunk 参数，尤其防止 overlap 大于等于窗口导致游标不前进。
 *
 * @param options 调用方传入的 chunk 配置。
 * @returns 配置合法时返回 undefined，否则返回结构化错误。
 */
function validateChunkingOptions(options: ChunkingOptions): RagStructuredError | undefined {
  if (options.strategy !== "fixed_size" && options.strategy !== "heading_aware" && options.strategy !== "table_aware") {
    return {
      code: "invalid_chunking_options",
      message: "chunk 策略必须是 fixed_size、heading_aware 或 table_aware。",
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
