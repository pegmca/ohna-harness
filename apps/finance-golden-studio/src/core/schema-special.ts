import { isRecord, issue } from "./schema.js";
import type { ValidationIssue } from "./schema.js";
import { resolveTickerAbsentTarget } from "./ticker-absent.js";

/**
 * 校验表格型答案具备结构化载荷。
 *
 * @param draft 作者对象。
 * @param errors 错误收集器。
 */
export function validateTableAnswer(
  draft: Record<string, unknown>,
  errors: ValidationIssue[]
): void {
  if (!isRecord(draft.gold_answer_table) && !isRecord(draft.gold_answer_form)) {
    errors.push(
      issue(
        "answer_structure_required",
        "type=table requires gold_answer_table or gold_answer_form.",
        "gold_answer_table"
      )
    );
  }
}

/**
 * 校验表格列、行和单元格。
 *
 * @param value 表格值。
 * @param errors 错误收集器。
 * @param warnings 警告收集器。
 */
export function validateTableStructure(
  value: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(
      issue(
        "table_columns_required",
        "gold_answer_table must be an object.",
        "gold_answer_table"
      )
    );
    return;
  }
  if (
    !Array.isArray(value.columns) ||
    value.columns.length === 0 ||
    !value.columns.every(
      (column) => typeof column === "string" && column.trim().length > 0
    )
  ) {
    errors.push(
      issue(
        "table_columns_required",
        "gold_answer_table.columns must be a non-empty string array.",
        "gold_answer_table.columns"
      )
    );
  }
  if (!Array.isArray(value.rows)) {
    errors.push(
      issue(
        "table_rows_required",
        "gold_answer_table.rows must be an array.",
        "gold_answer_table.rows"
      )
    );
    return;
  }
  const count = Array.isArray(value.columns) ? value.columns.length : undefined;
  value.rows.forEach((row, index) =>
    validateTableRow(row, index, count, errors, warnings)
  );
}

/**
 * 校验反例题与 resolution / evidence 的一致性。
 *
 * @param draft 作者对象。
 * @param errors 错误收集器。
 */
export function validateNegative(
  draft: Record<string, unknown>,
  errors: ValidationIssue[]
): void {
  if (draft.is_negative !== true) return;
  if (draft.type !== "negative") {
    errors.push(
      issue(
        "negative_type_required",
        "is_negative=true requires type=negative.",
        "type"
      )
    );
  }
  if (Array.isArray(draft.evidence) && draft.evidence.length > 0) {
    errors.push(
      issue(
        "negative_evidence_present",
        "is_negative=true requires an empty evidence array.",
        "evidence"
      )
    );
  }
  if (!isRecord(draft.resolution) || draft.resolution.type !== "ticker_absent") {
    errors.push(
      issue(
        "negative_resolution_required",
        "is_negative=true requires resolution.type=ticker_absent.",
        "resolution"
      )
    );
    return;
  }
  const target = resolveTickerAbsentTarget(draft.resolution);
  if (target.kind === "conflict") {
    errors.push(
      issue(
        "negative_ticker_conflict",
        `ticker_absent ticker=${target.directTicker} conflicts with scope ticker=${target.scopedTicker}.`,
        "resolution"
      )
    );
  }
  if (target.kind === "scoped" || target.kind === "invalid-scoped") {
    const scope =
      typeof draft.resolution.scope === "string"
        ? draft.resolution.scope.trim()
        : "";
    if (!/^ticker=\S+$/u.test(scope)) {
      errors.push(
        issue(
          "negative_scope_invalid",
          "Scoped ticker_absent resolution requires scope=ticker=<ticker>.",
          "resolution.scope"
        )
      );
    }
    const expectedReport =
      typeof draft.resolution.expected_report === "string"
        ? draft.resolution.expected_report.trim()
        : "";
    if (expectedReport !== "（无）") {
      errors.push(
        issue(
          "negative_scope_invalid",
          'Scoped ticker_absent resolution requires expected_report="（无）".',
          "resolution.expected_report"
        )
      );
    }
  }
}

/**
 * 校验单个表格行及其稀疏列警告。
 *
 * @param row 行值。
 * @param index 行索引。
 * @param columnCount 列数。
 * @param errors 错误收集器。
 * @param warnings 警告收集器。
 */
function validateTableRow(
  row: unknown,
  index: number,
  columnCount: number | undefined,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const field = `gold_answer_table.rows[${index}]`;
  if (!Array.isArray(row)) {
    errors.push(issue("table_row_not_array", `${field} must be an array.`, field));
    return;
  }
  row.forEach((cell, cellIndex) => {
    if (typeof cell !== "string") {
      errors.push(
        issue(
          "table_cell_not_string",
          `${field}[${cellIndex}] must be a string.`,
          `${field}[${cellIndex}]`
        )
      );
    }
  });
  if (columnCount !== undefined && row.length !== columnCount) {
    warnings.push(
      issue(
        "table_sparse_row",
        `${field} has ${row.length} cells but columns has ${columnCount}; confirm the sparse row is intentional.`,
        field
      )
    );
  }
}
