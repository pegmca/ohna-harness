import type {
  GoldenAnswerType,
  GoldenDifficulty,
  GoldenDraftType,
  GoldenReportType,
  GoldenSourceKind,
  KeywordReachabilityResult,
  ValidationIssue,
  ValidationIssueCode,
  ValidationReport
} from "./types.js";

export type {
  KeywordReachabilityResult,
  ValidationIssue,
  ValidationIssueCode,
  ValidationReport
};

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
