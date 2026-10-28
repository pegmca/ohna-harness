import type { PdfEvidenceDocument } from "./evidence.js";
import { readPdfEvidence } from "./evidence.js";
import { GoldenStudioError } from "./errors.js";
import type { KeywordReachabilityResult } from "./keywords.js";
import { validateKeywordReachability } from "./keywords.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestTripleKey } from "./manifest.js";
import { isRecord, issue } from "./schema.js";
import type { ValidationIssue } from "./schema.js";
import { validateDraftSchema } from "./schema-fields.js";
import { resolveTickerAbsentTarget, tickerPresentIssue } from "./ticker-absent.js";
import type {
  GoldenEvidence,
  GoldenReportType,
  GoldenSourceKind
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import { WorkspaceError } from "./workspace.js";

/** 已解析 golden 行及其原始位置。 */
export interface ValidationRecord {
  record: Record<string, unknown>;
  line: number;
  id?: string;
}

/** 单条作者集记录经过文件/关键词检查后的结果。 */
export interface ValidationPipelineRecord {
  line: number;
  id?: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  keywordResults: KeywordReachabilityResult[];
}

/** 作者集校验管道结果。 */
export interface ValidationPipelineResult {
  records: ValidationPipelineRecord[];
}

/**
 * 批量执行作者集逐行校验，并复用已读取的 manifest 与 PDF。
 *
 * schema 与 section 逐行执行；同一 PDF 只解析一次。无法安全读取的来源
 * 不参与关键词诊断，避免把一次 I/O 失败误报成关键词不可达。
 *
 * @param config 当前工作区配置。
 * @param records 已解析作者集行。
 * @param byTriple manifest 三元组索引。
 * @returns 保持输入顺序的逐行结果。
 */
export async function runValidationPipeline(
  config: WorkspaceConfig,
  records: readonly ValidationRecord[],
  byTriple: ReadonlyMap<string, ManifestRecord>
): Promise<ValidationPipelineResult> {
  const parsed = records.map((item) => ({
    ...item,
    schema: validateDraftSchema(item.record, { includeWarnings: false }),
    evidence: selectValidEvidence(item.record.evidence)
  }));
  const stable = parsed.filter(
    ({ schema, record, evidence }) =>
      !schema.errors.some(
        (candidate) =>
          candidate.code === "evidence_invalid" ||
          (candidate.code === "array_required" && candidate.field === "evidence")
      ) &&
      (evidence.length > 0 || record.is_negative === true) &&
      evidence.every(({ value }) => byTriple.has(manifestTripleKey(value)))
  );
  const loaded = await readUniqueEvidenceDocuments(
    config,
    stable.flatMap(({ evidence }) => evidence),
    byTriple
  );

  return {
    records: parsed.map(({ record, line, id, schema, evidence }) => {
      const errors = deduplicateIssues(schema.errors);
      const warnings = [...schema.warnings];
      const keywordResults = validateRecordReferences(
        record,
        evidence,
        byTriple,
        loaded.documents,
        errors,
        loaded.failures
      );
      return { line, ...(id ? { id } : {}), errors, warnings, keywordResults };
    })
  };
}

/**
 * 校验单条记录的 section、manifest 引用、反例与关键词。
 *
 * @param record 作者对象。
 * @param evidence 可安全定位的 evidence。
 * @param byTriple manifest 索引。
 * @param documents 已解析来源。
 * @param errors 错误收集器。
 * @param readFailures 三元组到 PDF 读取异常的索引。
 * @returns 关键词结果。
 */
export function validateRecordReferences(
  record: Record<string, unknown>,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  documents: ReadonlyMap<string, PdfEvidenceDocument>,
  errors: ValidationIssue[],
  readFailures: ReadonlyMap<string, unknown> = new Map()
): KeywordReachabilityResult[] {
  if (isRecord(record.resolution) && record.resolution.type === "ticker_absent") {
    validateNegativeTicker(record.resolution, byTriple, errors);
  }
  validateExpectedKeywords(record, errors);
  validateSections(record.evidence, errors);

  if (record.is_negative !== true && evidence.length === 0) {
    errors.push(
      issue(
        "evidence_required",
        "Non-negative cases require at least one complete evidence source.",
        "evidence"
      )
    );
  }
  for (const { value, index } of evidence) {
    if (!byTriple.has(manifestTripleKey(value))) {
      errors.push(
        issue(
          "evidence_not_in_manifest",
          `evidence[${index}] ${value.ticker}/${value.report_type}/${value.period} is not in manifest.`,
          `evidence[${index}]`
        )
      );
    }
  }

  const unavailable = new Set(
    evidence
      .map(({ value }) => manifestTripleKey(value))
      .filter((key) => byTriple.has(key) && !documents.has(key))
  );
  for (const { value, index } of evidence) {
    const key = manifestTripleKey(value);
    if (unavailable.delete(key)) {
      errors.push(toEvidenceIssue(readFailures.get(key), index));
    }
  }

  const recordDocuments = [
    ...new Set(
      evidence.flatMap(({ value }) => {
        const document = documents.get(manifestTripleKey(value));
        return document ? [document] : [];
      })
    )
  ];
  if (recordDocuments.length === 0 || !Array.isArray(record.expected_keywords)) {
    return [];
  }
  const keywordResults = validateKeywords(
    recordDocuments,
    record.expected_keywords,
    errors
  );
  return keywordResults;
}

/**
 * 将来源读取异常映射为报告问题。
 *
 * @param error 读取异常。
 * @param evidenceIndex evidence 索引。
 * @returns 校验问题。
 */
function toEvidenceIssue(error: unknown, evidenceIndex: number): ValidationIssue {
  const field = `evidence[${evidenceIndex}]`;
  if (error instanceof GoldenStudioError) {
    return issue(error.code, error.message, field);
  }
  if (error instanceof WorkspaceError) {
    return issue(error.code, error.message, field);
  }
  return issue(
    "evidence_parse_failed",
    error instanceof Error ? error.message : "Evidence PDF cannot be read.",
    field
  );
}

/**
 * 校验关键词可达性。
 *
 * @param documents 成功读取的来源 PDF。
 * @param keywords 作者关键词。
 * @param errors 错误收集器。
 * @returns 逐关键词诊断。
 */
function validateKeywords(
  documents: readonly PdfEvidenceDocument[],
  keywords: readonly unknown[],
  errors: ValidationIssue[]
): KeywordReachabilityResult[] {
  const validKeywords = keywords.filter(
    (keyword): keyword is string => typeof keyword === "string"
  );
  if (validKeywords.length !== keywords.length) return [];
  let result: ReturnType<typeof validateKeywordReachability>;
  try {
    result = validateKeywordReachability(documents, validKeywords);
  } catch (error) {
    errors.push(
      issue(
        "evidence_parse_failed",
        error instanceof Error ? error.message : "Keyword reachability check failed.",
        "expected_keywords"
      )
    );
    return [];
  }
  result.keywordResults.forEach((keywordResult, index) => {
    if (!keywordResult.reachable && keywordResult.reason === "unreachable") {
      errors.push(
        issue(
          "keyword_unreachable",
          `expected_keywords[${index}] (${keywordResult.keyword}) is not reachable in evidence PDFs.`,
          `expected_keywords[${index}]`
        )
      );
    }
  });
  return result.keywordResults;
}

/**
 * 校验非反例题必须提供非空关键词列表。
 *
 * @param record 作者对象。
 * @param errors 错误收集器。
 */
function validateExpectedKeywords(
  record: Record<string, unknown>,
  errors: ValidationIssue[]
): void {
  if (record.is_negative === true) return;
  if (
    !Array.isArray(record.expected_keywords) ||
    record.expected_keywords.length === 0
  ) {
    errors.push(
      issue(
        "expected_keywords_required",
        "Non-negative cases require at least one expected_keywords entry.",
        "expected_keywords"
      )
    );
  }
}

/**
 * 校验 evidence.section 已完成。
 *
 * @param value evidence 原值。
 * @param errors 错误收集器。
 */
function validateSections(value: unknown, errors: ValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  value.forEach((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.section !== "string") return;
    if (/（待补|\(待补|（候选|\(候选/u.test(candidate.section)) {
      errors.push(
        issue(
          "section_unresolved",
          `evidence[${index}].section still contains an unresolved marker.`,
          `evidence[${index}].section`
        )
      );
    }
  });
}

/**
 * 校验 scoped ticker_absent 的目标 ticker 确实不在 manifest。
 *
 * @param resolution ticker_absent resolution。
 * @param byTriple manifest 索引。
 * @param errors 错误收集器。
 */
function validateNegativeTicker(
  resolution: Record<string, unknown>,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  errors: ValidationIssue[]
): void {
  const target = resolveTickerAbsentTarget(resolution);
  if (
    target.kind === "missing" ||
    target.kind === "invalid-scoped" ||
    target.kind === "conflict"
  ) {
    return;
  }
  const ticker = target.ticker;
  if ([...byTriple.values()].some((record) => record.ticker === ticker)) {
    const found = tickerPresentIssue(target);
    if (found) errors.push(found);
  }
}

/**
 * 选择可参与 manifest/PDF 检查的 evidence。
 *
 * @param value evidence 原值。
 * @returns 合法来源及索引。
 */
export function selectValidEvidence(
  value: unknown
): Array<{ value: GoldenEvidence; index: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.ticker !== "string" ||
      candidate.ticker.trim().length === 0 ||
      typeof candidate.report_type !== "string" ||
      typeof candidate.period !== "string" ||
      candidate.period.trim().length === 0 ||
      typeof candidate.section !== "string" ||
      typeof candidate.page !== "number" ||
      typeof candidate.quote !== "string" ||
      typeof candidate.source_kind !== "string"
    ) {
      return [];
    }
    return [
      {
        value: {
          ticker: candidate.ticker,
          report_type: candidate.report_type as GoldenReportType,
          period: candidate.period,
          section: candidate.section,
          page: candidate.page,
          quote: candidate.quote,
          source_kind: candidate.source_kind as GoldenSourceKind,
          ...(typeof candidate.ocr_required === "boolean"
            ? { ocr_required: candidate.ocr_required }
            : {}),
          ...(typeof candidate.page_image_ref === "string"
            ? { page_image_ref: candidate.page_image_ref }
            : {})
        },
        index
      }
    ];
  });
}

/**
 * 按 manifest 三元组去重读取 PDF。
 *
 * @param config 当前工作区配置。
 * @param evidence 待读取来源。
 * @param byTriple manifest 索引。
 * @returns 三元组到成功证据文档的索引。
 */
async function readUniqueEvidenceDocuments(
  config: WorkspaceConfig,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  byTriple: ReadonlyMap<string, ManifestRecord>
): Promise<{
  documents: Map<string, PdfEvidenceDocument>;
  failures: Map<string, unknown>;
}> {
  const documents = new Map<string, PdfEvidenceDocument>();
  const failures = new Map<string, unknown>();
  const keys = new Set(evidence.map(({ value }) => manifestTripleKey(value)));
  for (const key of keys) {
    const manifestRecord = byTriple.get(key);
    if (!manifestRecord) continue;
    try {
      documents.set(key, await readPdfEvidence(config, manifestRecord.file_path));
    } catch (error) {
      failures.set(key, error);
    }
  }
  return { documents, failures };
}

/**
 * 去掉同字段同代码的重复 schema 诊断。
 *
 * @param issues 原始问题。
 * @returns 保持顺序的去重结果。
 */
function deduplicateIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((candidate) => {
    const key = `${candidate.code}\u0000${candidate.field ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
