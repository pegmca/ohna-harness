import {
  GOLDEN_ANSWER_TYPE_VALUES,
  GOLDEN_DIFFICULTY_VALUES,
  GOLDEN_REPORT_TYPE_VALUES,
  GOLDEN_SOURCE_KIND_VALUES,
  GOLDEN_TYPE_VALUES,
  isRecord,
  issue
} from "./schema.js";
import type {
  SchemaValidationOptions,
  SchemaValidationResult,
  ValidationIssue
} from "./schema.js";
import {
  validateNegative,
  validateTableAnswer,
  validateTableStructure
} from "./schema-special.js";

/**
 * 对单条作者对象执行纯结构校验。
 *
 * 此函数是唯一 schema 规则执行点，不读取文件；manifest、section 和 PDF
 * 可达性由 validate.ts 组合。所有检查只依赖输入对象，便于 CLI、HTTP、UI
 * 复用同一套字段规则。
 *
 * @param draft 待校验作者对象。
 * @param options 草稿 ID 等调用场景差异。
 * @returns 结构错误与稀疏表格警告。
 */
export function validateDraftSchema(
  draft: unknown,
  options: SchemaValidationOptions = {}
): SchemaValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!isRecord(draft)) {
    errors.push(issue("required_string_invalid", "Draft must be a JSON object."));
    return { errors, warnings };
  }

  validateId(draft.id, options.allowDraftId === true, errors);
  validateRequiredString(draft.query, "query", errors);
  validateEnum(draft.type, GOLDEN_TYPE_VALUES, "type", errors);
  validateEnum(draft.difficulty, GOLDEN_DIFFICULTY_VALUES, "difficulty", errors);
  validateEnum(draft.answer_type, GOLDEN_ANSWER_TYPE_VALUES, "answer_type", errors);
  validateRequiredString(draft.gold_answer, "gold_answer", errors);
  validateRequiredString(draft.answer_unit, "answer_unit", errors);
  validateRequiredString(draft.note, "note", errors);
  validateBooleanAndArrayFields(draft, errors);
  validateResolution(draft.resolution, errors);
  if (Array.isArray(draft.evidence)) validateEvidence(draft.evidence, errors);
  if (Array.isArray(draft.distractors)) validateDistractors(draft.distractors, errors);
  if (draft.type === "table") validateTableAnswer(draft, errors);
  validateTableStructure(draft.gold_answer_table, errors, warnings);
  validateFormStructure(draft.gold_answer_form, errors);
  validateNegative(draft, errors);
  if (draft.expected_keywords !== undefined) {
    validateExpectedKeywordsShape(draft.expected_keywords, errors);
  }
  if (draft.snapshot_dependent === true && !isRecord(draft.resolution)) {
    errors.push(
      issue(
        "resolution_required",
        "snapshot_dependent=true requires a resolution object.",
        "resolution"
      )
    );
  }
  return {
    errors,
    warnings: options.includeWarnings === false ? [] : warnings
  };
}

/**
 * 校验必填字符串。
 *
 * @param value 待校验值。
 * @param field 字段路径。
 * @param errors 错误收集器。
 */
export function validateRequiredString(
  value: unknown,
  field: string,
  errors: ValidationIssue[]
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(
      issue("required_string_invalid", `${field} must be a non-empty string.`, field)
    );
  }
}

/**
 * 校验布尔字段与数组字段。
 *
 * @param draft 作者对象。
 * @param errors 错误收集器。
 */
function validateBooleanAndArrayFields(
  draft: Record<string, unknown>,
  errors: ValidationIssue[]
): void {
  for (const field of ["requires_multi_doc", "is_negative"] as const) {
    if (typeof draft[field] !== "boolean") {
      errors.push(issue("boolean_required", `${field} must be a boolean.`, field));
    }
  }
  for (const field of ["evidence", "distractors"] as const) {
    if (!Array.isArray(draft[field])) {
      errors.push(issue("array_required", `${field} must be an array.`, field));
    }
  }
}

/**
 * 校验 evidence 元素。
 *
 * @param evidence evidence 数组。
 * @param errors 错误收集器。
 */
function validateEvidence(
  evidence: readonly unknown[],
  errors: ValidationIssue[]
): void {
  evidence.forEach((value, index) => {
    const field = `evidence[${index}]`;
    if (!isRecord(value)) {
      errors.push(issue("evidence_invalid", `${field} must be an object.`, field));
      return;
    }
    for (const key of ["ticker", "period", "section", "quote"]) {
      validateRequiredString(value[key], `${field}.${key}`, errors);
    }
    validateEnum(value.report_type, GOLDEN_REPORT_TYPE_VALUES, `${field}.report_type`, errors);
    validateEnum(value.source_kind, GOLDEN_SOURCE_KIND_VALUES, `${field}.source_kind`, errors);
    if (typeof value.page !== "number" || !Number.isFinite(value.page) || value.page < 0) {
      errors.push(
        issue(
          "evidence_invalid",
          `${field}.page must be a non-negative finite number.`,
          `${field}.page`
        )
      );
    }
    if (value.source_kind === "image" && value.ocr_required !== true) {
      errors.push(
        issue(
          "evidence_invalid",
          `${field} with source_kind=image requires ocr_required=true.`,
          `${field}.ocr_required`
        )
      );
    }
    if (value.page_image_ref !== undefined) {
      validateRequiredString(value.page_image_ref, `${field}.page_image_ref`, errors);
    }
  });
}

/**
 * 校验 distractors 元素。
 *
 * @param distractors distractor 数组。
 * @param errors 错误收集器。
 */
function validateDistractors(
  distractors: readonly unknown[],
  errors: ValidationIssue[]
): void {
  distractors.forEach((value, index) => {
    const field = `distractors[${index}]`;
    if (!isRecord(value)) {
      errors.push(issue("distractor_invalid", `${field} must be an object.`, field));
      return;
    }
    validateRequiredString(value.ticker, `${field}.ticker`, errors);
    validateRequiredString(value.period, `${field}.period`, errors);
    validateEnum(value.report_type, GOLDEN_REPORT_TYPE_VALUES, `${field}.report_type`, errors);
  });
}

/**
 * 校验 resolution 联合形态。
 *
 * @param value resolution 值。
 * @param errors 错误收集器。
 */
function validateResolution(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(issue("resolution_invalid", "resolution must be an object.", "resolution"));
    return;
  }
  if (value.type === "latest_by") {
    validateLatestBy(value, errors);
  } else if (value.type === "ticker_absent") {
    validateTickerAbsent(value, errors);
  } else {
    errors.push(
      issue(
        "resolution_invalid",
        "resolution.type must be latest_by or ticker_absent.",
        "resolution.type"
      )
    );
  }
}

/**
 * 校验 expected_keywords 自身类型。
 *
 * @param value 待校验值。
 * @param errors 错误收集器。
 */
function validateExpectedKeywordsShape(
  value: unknown,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    errors.push(
      issue("array_required", "expected_keywords must be a string array.", "expected_keywords")
    );
    return;
  }
  value.forEach((keyword, index) => {
    if (typeof keyword !== "string" || keyword.trim().length === 0) {
      errors.push(
        issue(
          typeof keyword === "string" ? "expected_keyword_empty" : "required_string_invalid",
          `expected_keywords[${index}] must be a non-empty string.`,
          `expected_keywords[${index}]`
        )
      );
    }
  });
}

/**
 * 校验表单结构。
 *
 * @param value 表单值。
 * @param errors 错误收集器。
 */
function validateFormStructure(value: unknown, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !Array.isArray(value.items)) {
    errors.push(
      issue(
        "form_items_required",
        "gold_answer_form.items must be an array.",
        "gold_answer_form.items"
      )
    );
    return;
  }
  value.items.forEach((item, index) => {
    const field = `gold_answer_form.items[${index}]`;
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      item.key.trim().length === 0 ||
      typeof item.value !== "string"
    ) {
      errors.push(issue("form_item_invalid", `${field} requires string key/value.`, field));
    }
  });
}

/**
 * 校验 latest_by resolution。
 *
 * @param value resolution。
 * @param errors 错误收集器。
 */
function validateLatestBy(value: Record<string, unknown>, errors: ValidationIssue[]): void {
  for (const key of ["field", "scope", "expected_report"]) {
    validateRequiredString(value[key], `resolution.${key}`, errors);
  }
  if (value.span !== undefined) {
    if (!isRecord(value.span)) {
      errors.push(issue("resolution_invalid", "resolution.span must be an object.", "resolution.span"));
    } else {
      validateRequiredString(value.span.window, "resolution.span.window", errors);
      validateRequiredString(value.span.rule, "resolution.span.rule", errors);
    }
  }
  if (value.coverage_note !== undefined) {
    validateRequiredString(value.coverage_note, "resolution.coverage_note", errors);
  }
}

/**
 * 校验 ticker_absent resolution。
 *
 * @param value resolution。
 * @param errors 错误收集器。
 */
function validateTickerAbsent(value: Record<string, unknown>, errors: ValidationIssue[]): void {
  if (value.ticker !== undefined) {
    validateRequiredString(value.ticker, "resolution.ticker", errors);
  } else {
    validateRequiredString(value.scope, "resolution.scope", errors);
    validateRequiredString(value.expected_report, "resolution.expected_report", errors);
  }
  if (value.note !== undefined) {
    validateRequiredString(value.note, "resolution.note", errors);
  }
}

/**
 * 校验 ID 使用 fin 编号。
 *
 * @param value 待校验值。
 * @param allowDraftId 是否接受草稿的 fin-D 编号。
 * @param errors 错误收集器。
 */
function validateId(
  value: unknown,
  allowDraftId: boolean,
  errors: ValidationIssue[]
): void {
  const pattern = allowDraftId ? /^fin-(?:D)?\d{3,}$/ : /^fin-\d{3,}$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(
      issue(
        "id_invalid",
        `id must be a string like ${allowDraftId ? "fin-D001" : "fin-001"}.`,
        "id"
      )
    );
  }
}

/**
 * 校验枚举字段。
 *
 * @template T 枚举值类型。
 * @param value 待校验值。
 * @param allowed 合法值。
 * @param field 字段路径。
 * @param errors 错误收集器。
 */
function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: ValidationIssue[]
): void {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(
      issue("enum_invalid", `${field} must be one of: ${allowed.join(", ")}.`, field)
    );
  }
}
