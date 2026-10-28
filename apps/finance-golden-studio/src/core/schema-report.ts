import type { KeywordReachabilityResult } from "./keywords.js";
import type { ValidationIssue, ValidationReport } from "./schema.js";

/**
 * 将结构问题、引用问题和关键词问题合并为一个报告。
 *
 * @param parts 各校验阶段的结果。
 * @returns 统一校验报告，ok 仅由 errors 决定。
 */
export function createValidationReport(parts: {
  errors?: readonly ValidationIssue[];
  warnings?: readonly ValidationIssue[];
  keywordResults?: readonly KeywordReachabilityResult[];
} = {}): ValidationReport {
  const errors = [...(parts.errors ?? [])];
  const warnings = [...(parts.warnings ?? [])];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    keywordResults: [...(parts.keywordResults ?? [])]
  };
}
