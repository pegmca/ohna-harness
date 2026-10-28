import type { GoldenStudioErrorCode } from "./types.js";
import type {
  GoldenAnswerType,
  GoldenDifficulty,
  GoldenDraftType,
  GoldenReportType,
  GoldenSourceKind
} from "./types.js";
import type { KeywordReachabilityResult } from "./keywords.js";

/** golden 校验问题的稳定代码。 */
export type ValidationIssueCode =
  | GoldenStudioErrorCode
  | WorkspaceValidationCode
  | "golden_file_not_found"
  | "golden_json_invalid"
  | "golden_line_not_object"
  | "golden_line_count_invalid"
  | "golden_id_duplicate"
  | "manifest_json_invalid"
  | "manifest_record_invalid"
  | "manifest_triple_duplicate"
  | "expected_keywords_required"
  | "expected_keyword_empty"
  | "keyword_unreachable"
  | "section_unresolved"
  | "evidence_required"
  | "evidence_not_in_manifest"
  | "negative_evidence_present"
  | "negative_resolution_required"
  | "negative_ticker_present"
  | "negative_scope_invalid"
  | "negative_type_required"
  | "table_columns_required"
  | "table_rows_required"
  | "table_row_not_array"
  | "table_sparse_row"
  | "table_cell_not_string"
  | "form_items_required"
  | "form_item_invalid"
  | "required_string_invalid"
  | "array_required"
  | "boolean_required"
  | "enum_invalid"
  | "id_invalid"
  | "evidence_invalid"
  | "distractor_invalid"
  | "answer_structure_required"
  | "resolution_required"
  | "resolution_invalid";

/** 与工作区配置错误码对齐的校验层代码。 */
type WorkspaceValidationCode =
  | "workspace_config_missing"
  | "invalid_root_path"
  | "manifest_not_found"
  | "path_outside_root"
  | "invalid_batch_name"
  | "invalid_draft_id";

/** 单条校验问题；field 指向作者可定位的 JSON 路径。 */
export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  field?: string;
  line?: number;
  id?: string;
}

/** CLI、HTTP、UI、promote 与 generate 共用的校验结果。 */
export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  keywordResults: KeywordReachabilityResult[];
}

/** 纯 schema 校验结果，不包含 manifest 或 PDF 读取。 */
export interface SchemaValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** 草稿与正式作者集共享结构、但 ID 允许范围不同。 */
export interface SchemaValidationOptions {
  allowDraftId?: boolean;
  /** 设为 false 可只返回硬结构错误；validateGolden 用它避免逐行重复表格警告。 */
  includeWarnings?: boolean;
}

/** 合法作者集题型。 */
export const GOLDEN_TYPE_VALUES: readonly GoldenDraftType[] = [
  "numeric_fact",
  "definitional",
  "comparison",
  "multi_doc",
  "table",
  "unit_trap",
  "negative"
];

/** 合法难度枚举。 */
export const GOLDEN_DIFFICULTY_VALUES: readonly GoldenDifficulty[] = [
  "easy",
  "medium",
  "hard"
];

/** 合法答案呈现类型。 */
export const GOLDEN_ANSWER_TYPE_VALUES: readonly GoldenAnswerType[] = [
  "number",
  "list",
  "table",
  "form",
  "text"
];

/** 合法报告类型。 */
export const GOLDEN_REPORT_TYPE_VALUES: readonly GoldenReportType[] = [
  "annual",
  "interim",
  "q1",
  "q2",
  "q3",
  "prospectus",
  "announcement",
  "esg"
];

/** 合法证据介质。 */
export const GOLDEN_SOURCE_KIND_VALUES: readonly GoldenSourceKind[] = [
  "text",
  "table",
  "image"
];

/**
 * 创建带稳定代码和可选字段路径的结构化校验问题。
 *
 * @param code 问题代码。
 * @param message 可展示的问题说明。
 * @param field 作者字段路径。
 * @returns 校验问题。
 */
export function issue(
  code: ValidationIssueCode,
  message: string,
  field?: string
): ValidationIssue {
  return field ? { code, message, field } : { code, message };
}

/**
 * 判断值是否为 JSON 普通对象。
 *
 * @param value 待判断值。
 * @returns 非 null、非数组对象时为 true。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
