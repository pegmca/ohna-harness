import type {
  GoldenAnswerTable,
  GoldenDraft,
  PdfEvidenceDocument
} from "../../../core/types.ts";

/** 关键词在已加载来源文档中的可达性摘要。 */
export interface KeywordReachabilityView {
  keyword: string;
  reachable: boolean;
  evidenceIndexes: number[];
}

/** 草稿的 PDF 来源选择项。 */
export interface DraftSourceOption {
  filePath: string;
  label: string;
  evidenceIndexes: number[];
}

/**
 * 把浏览器选中的证据文本收敛为可提交的 quote。
 *
 * 只有选中文本确实属于来源 block 时才接受，避免把工具栏或其他
 * 界面文字误写进作者证据。
 *
 * @param blockText 原始证据 block。
 * @param selectedText 浏览器选区文本。
 * @returns 去首尾空白后的 quote；不属于 block 时返回 undefined。
 */
export function createEvidenceQuote(
  blockText: string,
  selectedText: string
): string | undefined {
  const quote = selectedText.trim();
  return quote.length > 0 && blockText.includes(quote) ? quote : undefined;
}

/**
 * 在已加载证据中即时投影关键词可达性。
 *
 * 这里只给编辑时反馈；最终是否可审核仍以服务端校验报告为准。
 * 空白归一规则与 core 的关键词匹配一致，但不复制结构校验。
 *
 * @param documents 当前草稿来源文档。
 * @param keywords 作者关键词。
 * @returns 与关键词顺序一致的即时可达性。
 */
export function findKeywordReachability(
  documents: readonly PdfEvidenceDocument[],
  keywords: readonly string[]
): KeywordReachabilityView[] {
  const normalizedDocuments = documents.map((document) =>
    normalizeKeywordText(document.blocks.map((block) => block.text).join("\n"))
  );
  return keywords.map((keyword) => {
    const normalized = normalizeKeywordText(keyword);
    const evidenceIndexes =
      normalized.length === 0
        ? []
        : normalizedDocuments.flatMap((text, index) =>
            text.includes(normalized) ? [index] : []
          );
    return {
      keyword,
      reachable: evidenceIndexes.length > 0,
      evidenceIndexes
    };
  });
}

/**
 * 找出草稿可预览的语料相对 PDF 路径。
 *
 * 草稿存储只保存 source triple；挖掘时写入的 `_draft.file_path`
 * 是首选，图片证据的 page_image_ref 保留兼容的显式路径。
 *
 * @param draft 当前草稿。
 * @returns 语料相对 PDF 路径；无反例或来源时返回 undefined。
 */
export function resolveDraftSourcePath(draft: GoldenDraft): string | undefined {
  const draftPath = draft._draft.file_path;
  if (isPdfPath(draftPath)) return normalizeFilePath(draftPath);

  for (const evidence of draft.evidence) {
    const imageRef = evidence.page_image_ref;
    if (typeof imageRef === "string") {
      const path = imageRef.split("#", 1)[0];
      if (isPdfPath(path)) return normalizeFilePath(path);
    }
  }
  return undefined;
}

/**
 * 从草稿 evidence 与 metadata 汇总所有可预览来源。
 *
 * @param draft 当前草稿。
 * @returns 去重后的来源选项。
 */
export function listDraftSources(draft: GoldenDraft): DraftSourceOption[] {
  const sources: DraftSourceOption[] = [];
  const add = (filePath: string, index: number): void => {
    const normalized = normalizeFilePath(filePath);
    if (!isPdfPath(normalized)) return;
    const existing = sources.find((source) => source.filePath === normalized);
    if (existing) existing.evidenceIndexes.push(index);
    else {
      sources.push({
        filePath: normalized,
        label: `${draft.evidence[index]?.ticker ?? "Source"} · ${
          draft.evidence[index]?.period ?? ""
        }`,
        evidenceIndexes: [index]
      });
    }
  };

  const metadataSources = draft._draft.source_paths;
  if (Array.isArray(metadataSources)) {
    for (const source of metadataSources) {
      if (typeof source === "string") add(source, 0);
    }
  }
  draft.evidence.forEach((evidence, index) => {
    if (evidence.page_image_ref) add(evidence.page_image_ref.split("#", 1)[0], index);
  });
  if (sources.length === 0) {
    const fallback = resolveDraftSourcePath(draft);
    if (fallback) add(fallback, 0);
  }
  return sources;
}

/**
 * 更新表格列名并同步以旧列名索引的单位。
 *
 * @param table 原表格。
 * @param index 列索引。
 * @param value 新列名。
 * @returns 更新后的新表格。
 */
export function updateTableColumn(
  table: GoldenAnswerTable,
  index: number,
  value: string
): GoldenAnswerTable {
  const previous = table.columns[index];
  const columns = table.columns.map((column, current) =>
    current === index ? value : column
  );
  if (!table.units || previous === undefined) {
    return { ...table, columns };
  }
  const units = { ...table.units };
  if (Object.hasOwn(units, previous)) {
    units[value] = units[previous] ?? "";
    delete units[previous];
  }
  return { ...table, columns, units };
}

/**
 * 更新表格单元格，不修改原草稿对象。
 *
 * @param table 原表格。
 * @param rowIndex 行索引。
 * @param columnIndex 列索引。
 * @param value 单元格新值。
 * @returns 更新后的新表格。
 */
export function updateTableRow(
  table: GoldenAnswerTable,
  rowIndex: number,
  columnIndex: number,
  value: string
): GoldenAnswerTable {
  const rows = table.rows.map((row, currentRow) =>
    currentRow === rowIndex
      ? row.map((cell, currentColumn) =>
          currentColumn === columnIndex ? value : cell
        )
      : row
  );
  return { ...table, rows };
}

/**
 * 给表格追加空行，列数跟随当前表头。
 *
 * @param table 原表格。
 * @returns 增加一行后的新表格。
 */
export function appendTableRow(table: GoldenAnswerTable): GoldenAnswerTable {
  return {
    ...table,
    rows: [...table.rows, table.columns.map(() => "")]
  };
}

/**
 * 追加表格列并同步补齐所有行。
 *
 * @param table 原表格。
 * @returns 增加一列后的新表格。
 */
export function appendTableColumn(table: GoldenAnswerTable): GoldenAnswerTable {
  return {
    ...table,
    columns: [...table.columns, `Column ${table.columns.length + 1}`],
    rows: table.rows.map((row) => [...row, ""])
  };
}

/**
 * 删除表格列及其所有行值。
 *
 * @param table 原表格。
 * @param index 列索引。
 * @returns 删除后的新表格。
 */
export function removeTableColumn(
  table: GoldenAnswerTable,
  index: number
): GoldenAnswerTable {
  const column = table.columns[index];
  const units =
    table.units && column !== undefined
      ? Object.fromEntries(
          Object.entries(table.units).filter(([key]) => key !== column)
        )
      : table.units;
  return {
    ...table,
    columns: table.columns.filter((_, current) => current !== index),
    ...(units ? { units } : {}),
    rows: table.rows.map((row) =>
      row.filter((_, current) => current !== index)
    )
  };
}

/**
 * 删除表格行。
 *
 * @param table 原表格。
 * @param index 行索引。
 * @returns 删除后的新表格。
 */
export function removeTableRow(
  table: GoldenAnswerTable,
  index: number
): GoldenAnswerTable {
  return { ...table, rows: table.rows.filter((_, current) => current !== index) };
}

/**
 * 归一关键词文本，与 core 关键词可达性规则保持一致。
 *
 * @param text 原文本。
 * @returns 去空白并小写的文本。
 */
function normalizeKeywordText(text: string): string {
  return text.replace(/\s+/gu, "").toLowerCase();
}

/**
 * 规范化语料相对路径的分隔符。
 *
 * @param path 原始路径。
 * @returns 使用正斜杠的路径。
 */
function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 判断字符串是否指向 PDF。
 *
 * @param value 候选值。
 * @returns 非空且以 .pdf 结尾时为 true。
 */
function isPdfPath(value: unknown): value is string {
  return typeof value === "string" && /\.pdf$/iu.test(value.split("#", 1)[0] ?? "");
}
