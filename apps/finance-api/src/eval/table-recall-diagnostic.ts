import type { RagChunk } from "@aiagent/rag";

/** 诊断所需的检索结果最小投影。 */
export interface TableRecallResultLike {
  chunkId: string;
  text: string;
  metadata: Record<string, string | number | boolean | null>;
}

/** 单个 tableGroupId 的合并文本。 */
export interface TableGroupProjection {
  tableGroupId: string;
  text: string;
  hasWholeTable: boolean;
  hasSummary: boolean;
  chunkIds: string[];
}

/** 表格整行覆盖诊断结果。 */
export interface TableRowCoverage {
  coverage: number;
  singleChunkComplete: boolean;
  groupComplete: boolean;
  missingRows: string[];
  matchedRows: string[];
  matchedGroups: string[];
}

/**
 * 归一化表格比较文本，避免空白差异影响“完整出现”的判断。
 *
 * @param text 原始文本。
 * @returns 去空白并小写后的文本。
 */
export function normalizeTableText(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 按 tableGroupId 合并检索结果文本；无 group 的结果各自成组。
 *
 * @param goldRows gold 表首列行。
 * @param results 检索结果投影。
 * @returns 每个组的合并文本和命中类型。
 */
export function mergeRowsByTableGroup(
  goldRows: readonly string[],
  results: readonly TableRecallResultLike[]
): { groups: TableGroupProjection[]; singleChunkIds: string[] } {
  const groups = new Map<string, TableGroupProjection>();
  const singleChunkIds: string[] = [];
  const normalizedRows = goldRows.map(normalizeTableText);

  for (const result of results) {
    if (normalizedRows.every((row) => normalizeTableText(result.text).includes(row))) {
      singleChunkIds.push(result.chunkId);
    }

    const rawGroupId = result.metadata.tableGroupId;
    const tableGroupId = typeof rawGroupId === "string" ? rawGroupId : `ungrouped:${result.chunkId}`;
    const group = groups.get(tableGroupId) ?? {
      tableGroupId,
      text: "",
      hasWholeTable: false,
      hasSummary: false,
      chunkIds: []
    };
    group.text += `\n${result.text}`;
    group.hasWholeTable ||= result.metadata.isTableChunk === true;
    group.hasSummary ||= result.metadata.isTableSummary === true;
    group.chunkIds.push(result.chunkId);
    groups.set(tableGroupId, group);
  }

  return { groups: [...groups.values()], singleChunkIds };
}

/**
 * 计算 gold 表行在单 chunk 或 tableGroupId 组内的完整覆盖率。
 *
 * @param goldRows gold 表首列实体行。
 * @param results 检索结果投影。
 * @returns 单 chunk、组联合覆盖与缺行清单。
 */
export function calculateTableRowCoverage(
  goldRows: readonly string[],
  results: readonly TableRecallResultLike[]
): TableRowCoverage {
  const normalizedRows = goldRows.map(normalizeTableText);
  const { groups, singleChunkIds } = mergeRowsByTableGroup(goldRows, results);
  const groupCovered = new Set<string>();

  for (const group of groups) {
    const normalized = normalizeTableText(group.text);
    normalizedRows.forEach((row, index) => {
      if (normalized.includes(row)) groupCovered.add(goldRows[index]);
    });
  }

  const coveredByGroup = [...groupCovered];
  const missingRows = goldRows.filter((row) => !coveredByGroup.includes(row));
  const matchedRows = goldRows.filter((row) => groupCovered.has(row));
  const coverage = goldRows.length === 0 ? 1 : (goldRows.length - missingRows.length) / goldRows.length;

  return {
    coverage,
    singleChunkComplete: singleChunkIds.length > 0,
    groupComplete: missingRows.length === 0,
    missingRows,
    matchedRows,
    matchedGroups: groups.filter((group) => matchedRows.some((row) => normalizeTableText(group.text).includes(normalizeTableText(row)))).map((group) => group.tableGroupId)
  };
}

/**
 * 把运行时 chunk 转成诊断投影。
 *
 * @param chunk runtime RagChunk。
 * @returns 诊断结果投影。
 */
export function toTableRecallResult(chunk: RagChunk): TableRecallResultLike {
  return {
    chunkId: chunk.chunkId,
    text: chunk.text,
    metadata: chunk.metadata
  };
}
