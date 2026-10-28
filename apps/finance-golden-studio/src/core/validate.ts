import { readFile } from "node:fs/promises";
import { GoldenStudioError } from "./errors.js";
import type { PdfEvidenceDocument } from "./evidence.js";
import { readPdfEvidence } from "./evidence.js";
import type { KeywordReachabilityResult } from "./keywords.js";
import { validateKeywordReachability } from "./keywords.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestTripleKey, readManifest } from "./manifest.js";
import type {
  ValidationIssue,
  ValidationIssueCode,
  ValidationReport
} from "./schema.js";
import { isRecord, issue } from "./schema.js";
import { validateDraftSchema } from "./schema-fields.js";
import { createValidationReport } from "./schema-report.js";
import type { GoldenCase, GoldenDraft, GoldenEvidence } from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath, WorkspaceError } from "./workspace.js";

export type {
  ValidationIssue,
  ValidationIssueCode,
  ValidationReport
} from "./schema.js";

/** 待校验作者对象；运行时仍接受损坏 JSON 以返回结构化报告。 */
export type ValidatableDraft = GoldenDraft | GoldenCase | Record<string, unknown>;

/**
 * 校验单条草稿或作者集记录，并解析 manifest 来源 PDF 检查关键词可达性。
 *
 * 所有预期文件问题都收敛为 ValidationReport；工作区越界和无法继续的
 * manifest 结构问题优先 fail-closed，避免后续产生误导性缺失诊断。
 *
 * @param config 当前工作区配置。
 * @param draft 待校验的完整作者对象。
 * @returns 统一校验报告。
 */
export async function validateDraft(
  config: WorkspaceConfig,
  draft: ValidatableDraft
): Promise<ValidationReport> {
  const manifest = await readManifest(config);
  if (manifest.errors.length > 0) {
    return createValidationReport({ errors: manifest.errors });
  }
  const byTriple = new Map(
    manifest.records.map((record) => [manifestTripleKey(record), record])
  );
  return validateRecordWithManifest(config, draft, byTriple, true);
}

/**
 * 读取并逐行校验 golden.jsonl 作者集。
 *
 * 文件级格式错误、重复 ID 与单条作者错误都保留在同一报告中；
 * 一个坏行不会阻断其他合法行的校验。
 *
 * @param config 当前工作区配置。
 * @returns 整个作者集的统一校验报告。
 */
export async function validateGolden(config: WorkspaceConfig): Promise<ValidationReport> {
  assertContainedPath(config.workspaceRoot, config.goldenPath);
  const manifest = await readManifest(config);
  if (manifest.errors.length > 0) {
    return createValidationReport({ errors: manifest.errors });
  }

  let raw: string;
  try {
    raw = await readFile(config.goldenPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return createValidationReport({
        errors: [
          issue(
            "golden_file_not_found",
            `Golden file not found: ${config.goldenPath}.`
          )
        ]
      });
    }
    return createValidationReport({
      errors: [
        issue(
          "golden_json_invalid",
          `Golden file cannot be read: ${config.goldenPath}.`
        )
      ]
    });
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const keywordResults: KeywordReachabilityResult[] = [];
  const seenIds = new Map<string, number>();
  const byTriple = new Map(
    manifest.records.map((record) => [manifestTripleKey(record), record])
  );

  const lines = raw.split(/\r?\n/);
  const nonBlankLines = lines.filter((line) => line.trim().length > 0);
  if (nonBlankLines.length === 0) {
    errors.push(
      issue("golden_line_count_invalid", "Golden file must contain at least one case.")
    );
  }
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    const parsed = parseGoldenLine(line, lineNumber, errors);
    if (!parsed) continue;

    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    if (id) {
      const firstLine = seenIds.get(id);
      if (firstLine !== undefined) {
        errors.push({
          ...issue(
            "golden_id_duplicate",
            `Golden id ${id} is duplicated (lines ${firstLine}, ${lineNumber}).`,
            "id"
          ),
          line: lineNumber,
          id
        });
      } else {
        seenIds.set(id, lineNumber);
      }
    }

    const report = await validateRecordWithManifest(config, parsed, byTriple, false);
    errors.push(...withLine(report.errors, lineNumber, id));
    warnings.push(...withLine(report.warnings, lineNumber, id));
    keywordResults.push(...report.keywordResults);
  }

  return createValidationReport({ errors, warnings, keywordResults });
}

/**
 * 在已读取 manifest 的前提下校验单条作者集记录。
 *
 * @param config 当前工作区配置。
 * @param input 待校验记录。
 * @param byTriple manifest 三元组索引。
 * @param allowDraftId 是否接受 fin-D 草稿编号。
 * @returns 统一校验报告。
 */
async function validateRecordWithManifest(
  config: WorkspaceConfig,
  input: unknown,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  allowDraftId: boolean
): Promise<ValidationReport> {
  const schema = validateDraftSchema(input, { allowDraftId });
  const errors = deduplicateIssues(schema.errors);
  const warnings = [...schema.warnings];
  const keywordResults: KeywordReachabilityResult[] = [];
  const record = isRecord(input) ? input : {};

  if (isRecord(record.resolution) && record.resolution.type === "ticker_absent") {
    validateNegativeTicker(record.resolution, byTriple, errors);
  }
  validateExpectedKeywords(record, errors);
  validateSections(record.evidence, errors);

  const evidence = selectValidEvidence(record.evidence);
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
  if (evidence.length === 0 || !errors.some((candidate) => candidate.code === "evidence_not_in_manifest")) {
    const parsed = await readEvidenceDocuments(config, evidence, byTriple, errors);
    if (parsed.length > 0) {
      keywordResults.push(
        ...validateKeywords(
          parsed.map((item) => item.document),
          record.expected_keywords,
          errors
        )
      );
    }
  }

  return createValidationReport({ errors, warnings, keywordResults });
}

/**
 * 校验所有可定位 evidence 的来源 PDF，并保留文档索引。
 *
 * @param config 当前工作区配置。
 * @param evidence 合法 evidence 及其数组索引。
 * @param byTriple manifest 索引。
 * @param errors 错误收集器。
 * @returns 读取成功的来源文档。
 */
async function readEvidenceDocuments(
  config: WorkspaceConfig,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  errors: ValidationIssue[]
): Promise<Array<{ document: PdfEvidenceDocument; index: number }>> {
  const documents: Array<{ document: PdfEvidenceDocument; index: number }> = [];
  for (const item of evidence) {
    const manifestRecord = byTriple.get(manifestTripleKey(item.value));
    if (!manifestRecord) continue;
    try {
      documents.push({
        document: await readPdfEvidence(config, manifestRecord.file_path),
        index: item.index
      });
    } catch (error) {
      errors.push(toEvidenceIssue(error, item.index));
    }
  }
  return documents;
}

/**
 * 校验关键词必填、空白与源文本可达性。
 *
 * @param documents 成功读取的来源 PDF。
 * @param keywords 作者关键词。
 * @param errors 错误收集器。
 * @returns 逐关键词诊断。
 */
function validateKeywords(
  documents: readonly PdfEvidenceDocument[],
  keywords: unknown,
  errors: ValidationIssue[]
): KeywordReachabilityResult[] {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  const validKeywords = keywords.filter(
    (keyword): keyword is string => typeof keyword === "string"
  );
  if (validKeywords.length !== keywords.length) return [];

  const result = validateKeywordReachability(documents, validKeywords);
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
 * 校验非反例题必须有非空 expected_keywords。
 *
 * @param record 作者对象。
 * @param errors 错误收集器。
 */
function validateExpectedKeywords(
  record: Record<string, unknown>,
  errors: ValidationIssue[]
): void {
  if (record.is_negative === true) return;
  if (!Array.isArray(record.expected_keywords) || record.expected_keywords.length === 0) {
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
 * 校验 evidence.section 已完成，不接受待补或候选标记。
 *
 * @param evidence evidence 原值。
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
  const ticker =
    typeof resolution.ticker === "string"
      ? resolution.ticker
      : extractScopedTicker(resolution.scope);
  if (!ticker) return;
  const found = [...byTriple.values()].some((record) => record.ticker === ticker);
  if (found) {
    errors.push(
      issue(
        "negative_ticker_present",
        `Negative resolution ticker ${ticker} exists in manifest.`,
        "resolution.scope"
      )
    );
  }
}

/**
 * 从 resolution.scope 提取 ticker。
 *
 * @param value scope 值。
 * @returns ticker；格式不符时为 undefined。
 */
function extractScopedTicker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^ticker=(\S+)$/u.exec(value.trim());
  return match?.[1];
}

/**
 * 选出结构可安全参与 manifest 与 PDF 检查的 evidence。
 *
 * @param value evidence 原值。
 * @returns 合法来源及其原数组索引。
 */
function selectValidEvidence(
  value: unknown
): Array<{ value: GoldenEvidence; index: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.ticker !== "string" ||
      typeof candidate.report_type !== "string" ||
      typeof candidate.period !== "string"
    ) {
      return [];
    }
    return [{ value: candidate as unknown as GoldenEvidence, index }];
  });
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
 * 解析单行 golden 对象并保留行号。
 *
 * @param line 原始行。
 * @param lineNumber 一行起始编号。
 * @param errors 错误收集器。
 * @returns 普通对象；解析失败时为 undefined。
 */
function parseGoldenLine(
  line: string,
  lineNumber: number,
  errors: ValidationIssue[]
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    errors.push({
      ...issue(
        "golden_json_invalid",
        `line[${lineNumber}] is not valid JSON: ${
          error instanceof Error ? error.message : "unknown parse error"
        }.`
      ),
      line: lineNumber
    });
    return undefined;
  }
  if (!isRecord(parsed)) {
    errors.push({
      ...issue("golden_line_not_object", `line[${lineNumber}] must be a JSON object.`),
      line: lineNumber
    });
    return undefined;
  }
  return parsed;
}

/**
 * 为作者集问题补充行号与 ID。
 *
 * @param issues 单条记录问题。
 * @param line 行号。
 * @param id 作者 ID。
 * @returns 带来源定位的问题。
 */
function withLine(
  issues: readonly ValidationIssue[],
  line: number,
  id: string | undefined
): ValidationIssue[] {
  return issues.map((candidate) => ({
    ...candidate,
    line,
    ...(id ? { id } : {})
  }));
}

/**
 * 去掉同一字段同一代码的重复 schema 诊断，保留首次出现的说明。
 *
 * 不同检查可能同时发现同一字段为空；UI 只需要一条可操作错误。
 *
 * @param issues 原始 schema 问题。
 * @returns 保持顺序的去重问题。
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

/**
 * 判断文件不存在。
 *
 * @param error 文件系统异常。
 * @returns ENOENT 时为 true。
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
