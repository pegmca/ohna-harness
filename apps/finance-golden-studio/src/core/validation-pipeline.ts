import type { PdfEvidenceDocument } from "./evidence.js";
import { readPdfEvidence } from "./evidence.js";
import { GoldenStudioError } from "./errors.js";
import type { ManifestIndex } from "./evidence-resolution.js";
import {
  resolveEvidenceRecord,
  resolveLatestManifestRecord,
  type ManifestEvidenceResolution,
  type ManifestLatestResolution
} from "./evidence-resolution.js";
import type {
  KeywordDiagnostic,
  KeywordReachabilityResult
} from "./keywords.js";
import { validateKeywordReachability } from "./keywords.js";
import { attributeKeywordResults } from "./keyword-report.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestFilePathKey } from "./manifest.js";
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
  keywordResults: KeywordDiagnostic[];
}

/** 作者集校验管道结果。 */
export interface ValidationPipelineResult {
  records: ValidationPipelineRecord[];
}

/** 单条记录按 exact/latest_by 规则解析 evidence 的中间结果。 */
type RecordEvidenceResolution =
  | { kind: "resolved"; record: ManifestRecord }
  | { kind: "exact"; result: Exclude<ManifestEvidenceResolution, { kind: "resolved" }> }
  | { kind: "latest"; result: ManifestLatestResolution };

/**
 * 批量执行作者集逐行校验，并复用已读取的 manifest 与 PDF。
 *
 * schema 与 section 逐行执行；同一 PDF 只解析一次。无法安全读取的来源
 * 不参与关键词诊断，避免把一次 I/O 失败误报成关键词不可达。
 *
 * @param config 当前工作区配置。
 * @param records 已解析作者集行。
 * @param manifestIndex manifest 文件身份与语义索引。
 * @returns 保持输入顺序的逐行结果。
 */
export async function runValidationPipeline(
  config: WorkspaceConfig,
  records: readonly ValidationRecord[],
  manifestIndex: ManifestIndex
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
      evidence.every(({ value }) => {
        const resolution = resolveRecordEvidence(record, value, manifestIndex);
        return resolution.kind === "resolved";
      })
  );
  const loaded = await readUniqueEvidenceDocuments(
    config,
    stable.flatMap(({ record, evidence }) =>
      evidence.map((item) => ({ ...item, record }))
    ),
    manifestIndex
  );

  return {
    records: parsed.map(({ record, line, id, schema, evidence }) => {
      const errors = deduplicateIssues(schema.errors);
      const warnings = [...schema.warnings];
      const keywordResults = validateRecordReferences(
        record,
        evidence,
        manifestIndex,
        loaded.documents,
        errors,
        loaded.failures
      );
      return {
        line,
        ...(id ? { id } : {}),
        errors,
        warnings,
        keywordResults: attributeKeywordResults(
          record,
          evidence,
          (value) => {
            const resolution = resolveRecordEvidence(record, value, manifestIndex);
            return resolution.kind === "resolved"
              ? resolution.record.file_path
              : undefined;
          },
          keywordResults
        )
      };
    })
  };
}

/**
 * 校验单条记录的 section、manifest 引用、反例与关键词。
 *
 * @param record 作者对象。
 * @param evidence 可安全定位的 evidence。
 * @param manifestIndex manifest 文件身份与语义索引。
 * @param documents 已解析来源。
 * @param errors 错误收集器。
 * @param readFailures file_path 到 PDF 读取异常的索引。
 * @returns 关键词结果。
 */
export function validateRecordReferences(
  record: Record<string, unknown>,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  manifestIndex: ManifestIndex,
  documents: ReadonlyMap<string, PdfEvidenceDocument>,
  errors: ValidationIssue[],
  readFailures: ReadonlyMap<string, unknown> = new Map()
): KeywordReachabilityResult[] {
  if (isRecord(record.resolution) && record.resolution.type === "ticker_absent") {
    validateNegativeTicker(record.resolution, manifestIndex, errors);
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
  for (const { value, index: evidenceIndex } of evidence) {
    const resolution = resolveRecordEvidence(record, value, manifestIndex);
    if (resolution.kind === "latest") {
      addLatestByResolutionErrors(
        resolution.result,
        evidenceIndex,
        errors
      );
      continue;
    }
    const exact = resolution.kind === "resolved"
      ? undefined
      : resolution.result;
    if (exact?.kind === "not_found") {
      errors.push(
        issue(
          "evidence_not_in_manifest",
          `evidence[${evidenceIndex}] ${value.ticker}/${value.report_type}/${value.period} is not in manifest.`,
          `evidence[${evidenceIndex}]`
        )
      );
    }
    if (exact?.kind === "ambiguous") {
      errors.push(
        issue(
          "evidence_source_ambiguous",
          `evidence[${evidenceIndex}] ${value.ticker}/${value.report_type}/${value.period} matches multiple documents: ${exact.candidateFilePaths.join(", ")}. Set document_file_path to select one.`,
          `evidence[${evidenceIndex}].document_file_path`
        )
      );
    }
    if (exact?.kind === "selector_not_found") {
      errors.push(
        issue(
          "evidence_document_selector_not_found",
          `evidence[${evidenceIndex}].document_file_path is not declared by the manifest: ${exact.filePath}.`,
          `evidence[${evidenceIndex}].document_file_path`
        )
      );
    }
    if (exact?.kind === "selector_mismatch") {
      errors.push(
        issue(
          "evidence_document_selector_mismatch",
          `evidence[${evidenceIndex}].document_file_path ${exact.filePath} has semantic fields ${exact.recordSemantic}, expected ${exact.semantic}.`,
          `evidence[${evidenceIndex}].document_file_path`
        )
      );
    }
  }

  const unavailable = new Set(
    evidence.flatMap(({ value }) => {
      const resolution = resolveRecordEvidence(record, value, manifestIndex);
      if (resolution.kind !== "resolved") return [];
      const key = manifestFilePathKey(resolution.record.file_path);
      return documents.has(key) ? [] : [key];
    })
  );
  for (const { value, index: evidenceIndex } of evidence) {
    const resolution = resolveRecordEvidence(record, value, manifestIndex);
    if (resolution.kind !== "resolved") continue;
    const key = manifestFilePathKey(resolution.record.file_path);
    if (unavailable.delete(key)) {
      errors.push(toEvidenceIssue(readFailures.get(key), evidenceIndex));
    }
  }

  const recordDocuments = [
    ...new Set(
      evidence.flatMap(({ value }) => {
        const resolution = resolveRecordEvidence(record, value, manifestIndex);
        if (resolution.kind !== "resolved") return [];
        const document = documents.get(
          manifestFilePathKey(resolution.record.file_path)
        );
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
  index: ManifestIndex,
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
  if (index.records.some((record) => record.ticker === ticker)) {
    const found = tickerPresentIssue(target);
    if (found) errors.push(found);
  }
}

/**
 * 按记录 resolution 规则解析 evidence 的稳定文件身份。
 *
 * latest_by 在 `expected_report` 与 scope 命中当前 evidence 时重算最新文档；
 * 其余情况仍走精确语义/文件身份解析。latest_by 失败不退回行序选择。
 *
 * @param record 作者记录。
 * @param evidence evidence 引用。
 * @param index manifest 文件身份与语义索引。
 * @returns 唯一记录或精确/latest 结构化失败。
 */
export function resolveRecordEvidence(
  record: Record<string, unknown>,
  evidence: GoldenEvidence,
  index: ManifestIndex
): RecordEvidenceResolution {
  if (isLatestByEvidenceResolution(record.resolution, evidence)) {
    const resolution = record.resolution as Record<string, unknown>;
    const variant =
      typeof resolution.variant === "string" &&
      resolution.variant.trim().length > 0
        ? resolution.variant
        : undefined;
    const latest = resolveLatestManifestRecord(
      index,
      {
        ticker: evidence.ticker,
        report_type: evidence.report_type,
        period: evidence.period
      },
      variant
    );
    return latest.kind === "resolved"
      ? { kind: "resolved", record: latest.record }
      : { kind: "latest", result: latest };
  }

  const exact = resolveEvidenceRecord(evidence, index);
  return exact.kind === "resolved"
    ? { kind: "resolved", record: exact.record }
    : { kind: "exact", result: exact };
}

/**
 * 将 latest_by 结构化失败追加为稳定校验问题。
 *
 * @param resolution latest_by 解析结果。
 * @param evidenceIndex evidence 数组索引。
 * @param errors 错误收集器。
 */
function addLatestByResolutionErrors(
  resolution: ManifestLatestResolution,
  evidenceIndex: number,
  errors: ValidationIssue[]
): void {
  if (resolution.kind === "ambiguous") {
    errors.push(
      issue(
        "latest_by_ambiguous",
        `latest_by for evidence[${evidenceIndex}] is ambiguous on ${resolution.disclosureDate}: ${resolution.candidateFilePaths.join(", ")}. Set resolution.variant to select one.`,
        "resolution.variant"
      )
    );
    return;
  }
  if (resolution.kind === "variant_not_found") {
    errors.push(
      issue(
        "latest_by_variant_not_found",
        `resolution.variant ${resolution.variant} has no manifest records for ${resolution.scope.ticker}/${resolution.scope.report_type}/${resolution.scope.period}.`,
        "resolution.variant"
      )
    );
    return;
  }
  errors.push(
    issue(
      "evidence_not_in_manifest",
      `latest_by cannot resolve any manifest record for evidence[${evidenceIndex}].`,
      `evidence[${evidenceIndex}]`
    )
  );
}

/**
 * 判断当前 evidence 是否应由 latest_by 重算。
 *
 * @param resolution 原 resolution 值。
 * @param evidence evidence 引用。
 * @returns 命中 latest_by 规则时为 true。
 */
function isLatestByEvidenceResolution(
  resolution: unknown,
  evidence: GoldenEvidence
): boolean {
  if (!isRecord(resolution) || resolution.type !== "latest_by") return false;
  if (
    `${evidence.report_type}/${evidence.period}` !== resolution.expected_report
  ) {
    return false;
  }
  const match = /^ticker=([^,;\s]+)$/u.exec(
    typeof resolution.scope === "string" ? resolution.scope.trim() : ""
  );
  return match?.[1] === evidence.ticker;
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
            : {}),
          ...(typeof candidate.document_file_path === "string" &&
          candidate.document_file_path.trim().length > 0
            ? { document_file_path: candidate.document_file_path }
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
 * @param index manifest 文件身份与语义索引。
 * @returns file_path 到成功证据文档的索引。
 */
async function readUniqueEvidenceDocuments(
  config: WorkspaceConfig,
  evidence: ReadonlyArray<{
    value: GoldenEvidence;
    index: number;
    record: Record<string, unknown>;
  }>,
  index: ManifestIndex
): Promise<{
  documents: Map<string, PdfEvidenceDocument>;
  failures: Map<string, unknown>;
}> {
  const documents = new Map<string, PdfEvidenceDocument>();
  const failures = new Map<string, unknown>();
  const filePaths = new Set(
    evidence.flatMap(({ record, value }) => {
      const resolution = resolveRecordEvidence(record, value, index);
      return resolution.kind === "resolved"
        ? [resolution.record.file_path]
        : [];
    })
  );
  for (const filePath of filePaths) {
    const manifestRecord = index.byFilePath.get(manifestFilePathKey(filePath));
    if (!manifestRecord) continue;
    try {
      documents.set(
        manifestFilePathKey(filePath),
        await readPdfEvidence(config, manifestRecord.file_path)
      );
    } catch (error) {
      failures.set(manifestFilePathKey(filePath), error);
    }
  }
  return { documents, failures };
}

/**
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
