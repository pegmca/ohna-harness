import type { IngestedTextBlockDto } from "@aiagent/types";
import type { ChunkBlocksInput, ChunkingOptions, RagChunk } from "./types.js";

/** table_aware 聚合后的表组。 */
interface TableGroupDraft {
  rows: IngestedTextBlockDto[];
  header?: string;
  heading?: string;
  pageStart?: number;
  pageEnd?: number;
}

type ChunkDraft = Omit<RagChunk, "id" | "chunkId" | "chunkIndex"> & {
  id: string;
  chunkId: string;
  chunkIndex: number;
};

/**
 * 将 table_aware blocks 聚合为整表与 summary sibling chunks。
 *
 * @param input 文档身份与 blocks。
 * @param options 已校验切块配置。
 * @returns 未补最终 chunkIndex 的 chunk 草稿。
 */
export function createTableAwareChunks(input: ChunkBlocksInput, options: ChunkingOptions): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  const groups: TableGroupDraft[] = [];
  let current: TableGroupDraft | undefined;
  let latestHeading: string | undefined;
  let baseCharStart = 0;
  let pendingRowLabel = "";

  const finishGroup = (): void => {
    if (current && current.rows.length > 0) groups.push(current);
    current = undefined;
  };

  for (const block of input.blocks) {
    const text = block.text.trim();
    const blockCharStart = baseCharStart;
    baseCharStart += block.text.length + 2;
    if (block.heading) latestHeading = block.heading;

    if (block.metadata?.isTableRow === true) {
      current ??= { rows: [], heading: latestHeading };
      const nextLength = current.rows.reduce((total, row) => total + row.text.length + 1, 0) + block.text.length + 1;
      if (nextLength > (options.tableMaxChars ?? 30000)) {
        finishGroup();
        current = { rows: [], heading: latestHeading };
      }
      const row = pendingRowLabel ? { ...block, text: `${pendingRowLabel}${block.text.trim()}` } : block;
      pendingRowLabel = "";
      current.rows.push(row);
      if (block.pageNumber !== undefined) {
        current.pageStart ??= block.pageNumber;
        current.pageEnd = block.pageNumber;
      }
      if (!isNumericDataRow(text)) current.header ??= text;
      continue;
    }

    if (current && block.heading === undefined) {
      if (isTableContinuationBlock(block, options.tableHeaderFooterMaxChars ?? 80)) {
        continue;
      }
      // 表内换行的业务文本/子字段不是新表；粘回当前表组，避免一行一组的碎片。
      current.rows.push(block);
      if (isRowLabelFragment(block.text)) pendingRowLabel += block.text.trim();
      continue;
    }
    finishGroup();
    if (text.length === 0) continue;
    chunks.push(...createFixedChunks(block, input, blockCharStart, options));
  }
  finishGroup();

  for (const [groupIndex, group] of groups.entries()) {
    chunks.push(...createGroupChunks(group, input, groupIndex));
  }

  return chunks;
}

/**
 * 创建单个表组的整表与 summary chunks。
 *
 * @param group 聚合表组。
 * @param input 文档身份。
 * @param groupIndex 文档内表组编号。
 * @returns 整表与 summary chunk 草稿。
 */
function createGroupChunks(
  group: TableGroupDraft,
  input: ChunkBlocksInput,
  groupIndex: number
): ChunkDraft[] {
  const rows = group.rows;
  const header = group.header ?? "";
  const tableGroupId = `${input.documentId}_table_${String(groupIndex).padStart(4, "0")}`;
  const tableText = rows.map((row) => row.text.trim()).join("\n");
  const rowKeys = rows
    .filter((row) => row.text.trim() !== header)
    .map((row) => splitTableCells(row.text)[0]?.trim())
    .filter((value): value is string => Boolean(value));
  const pageStart = group.pageStart ?? rows[0]?.pageNumber;
  const pageEnd = group.pageEnd ?? rows.at(-1)?.pageNumber;
  const metadata: Record<string, string | number | boolean | null> = {
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
  const summaryText = [header, `行数：${rows.length} 行`, `首列：${[...new Set(rowKeys)].join("、")}`].join("\n");

  return [
    createChunkDraft(input, tableText, metadata, true, pageStart, group.heading),
    createChunkDraft(input, summaryText, metadata, false, pageStart, group.heading)
  ];
}

/**
 * 创建整表或 summary chunk 草稿。
 *
 * @param input 文档身份。
 * @param text chunk 文本。
 * @param metadata 表组公共 metadata。
 * @param isTableChunk 是否整表。
 * @param page 起始页。
 * @param heading 表组 heading。
 * @returns chunk 草稿。
 */
function createChunkDraft(
  input: ChunkBlocksInput,
  text: string,
  metadata: Record<string, string | number | boolean | null>,
  isTableChunk: boolean,
  page: number | undefined,
  heading: string | undefined
): ChunkDraft {
  return {
    documentId: input.documentId,
    source: input.source,
    id: "",
    chunkId: "",
    chunkIndex: -1,
    text,
    charStart: 0,
    charEnd: text.length,
    startOffset: 0,
    endOffset: text.length,
    ...(page !== undefined ? { page, pageNumber: page } : {}),
    ...(heading !== undefined ? { heading } : {}),
    metadata: { ...metadata, [isTableChunk ? "isTableChunk" : "isTableSummary"]: true }
  };
}

/**
 * 为非表格 block 创建 fixed-size chunk 草稿。
 *
 * @param block 非表 block。
 * @param input 文档身份。
 * @param baseCharStart block 在拼接文本中的起点。
 * @param options 切块配置。
 * @returns 非表 chunk 草稿。
 */
function createFixedChunks(
  block: IngestedTextBlockDto,
  input: ChunkBlocksInput,
  baseCharStart: number,
  options: ChunkingOptions
): ChunkDraft[] {
  const text = block.text.trim();
  const step = options.maxChars - options.overlapChars;
  const drafts: ChunkDraft[] = [];

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + options.maxChars, text.length);
    const charStart = baseCharStart + start;
    const charEnd = baseCharStart + end;
    drafts.push({
      documentId: input.documentId,
      source: input.source,
      id: "",
      chunkId: "",
      chunkIndex: -1,
      text: text.slice(start, end),
      charStart,
      charEnd,
      startOffset: charStart,
      endOffset: charEnd,
      ...(block.pageNumber !== undefined ? { page: block.pageNumber, pageNumber: block.pageNumber } : {}),
      ...(block.heading !== undefined ? { heading: block.heading } : {}),
      metadata: {
        strategy: "table_aware",
        blockId: block.id,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
        pageNumber: block.pageNumber ?? null,
        heading: block.heading ?? null,
        ...block.metadata,
        charStart,
        charEnd
      }
    });
    if (end >= text.length) break;
  }

  return drafts;
}

/**
 * 识别跨页重复页眉/页脚等可忽略的短非表行。
 *
 * @param block 非表 block。
 * @param maxChars 豁免长度上限。
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
 * 按稳定间隔拆分表格行。
 *
 * @param text 表行文本。
 * @returns 单元格文本。
 */
function splitTableCells(text: string): string[] {
  return text.split(/[ \t]{2,}|\u3000+/).filter((cell) => cell.trim().length > 0);
}

/**
 * 使用中位数去抖估算列数，并排除稀疏抵减行。
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

  if (counts.length > 0) return counts[Math.floor(counts.length / 2)];
  const fallback = rows.map((row) => Number(row.metadata?.tableColumnCount ?? splitTableCells(row.text).length));
  return fallback.sort((left, right) => left - right)[Math.floor(fallback.length / 2)] ?? 0;
}

/**
 * 判断稀疏抵减行。
 *
 * @param row 表行。
 * @returns 是否属于明细抵减行。
 */
function isSparseDeductionRow(row: IngestedTextBlockDto): boolean {
  return /^(?:其中|减[：:]|加[：:])/.test(row.text.trim());
}

/**
 * 判断一行是否含数值数据，避免首个数据行被误当表头。
 *
 * @param text 表行文本。
 * @returns 是否含数值单元格。
 */
function isNumericDataRow(text: string): boolean {
  return splitTableCells(text).slice(1).some((cell) => /^[\s(（+\-]?[\d,.%（）()]+[\s)）]?$/.test(cell.trim()));
}

/**
 * 判断非表行是否是行标签的短换行片段，可粘到后续数值行。
 *
 * @param text 非表行文本。
 * @returns 是否为短标签片段。
 */
function isRowLabelFragment(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length > 12) return false;

  return !/(?:公司|股份|年度报告|半年度报告|季度报告|第\d+页|\d+\/\d+)/.test(normalized);
}
