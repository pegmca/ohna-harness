import { readFile } from "node:fs/promises";
import type { PdfEvidenceDocument } from "./evidence.js";
import { readPdfEvidence } from "./evidence.js";
import type { ManifestIndex } from "./evidence-resolution.js";
import {
  createManifestIndex,
  resolveEvidenceRecord
} from "./evidence-resolution.js";
import type {
  KeywordDiagnostic
} from "./keywords.js";
import { attributeKeywordResults } from "./keyword-report.js";
import { manifestFilePathKey, readManifest } from "./manifest.js";
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
import { assertContainedPath } from "./workspace.js";
import {
  runValidationPipeline,
  selectValidEvidence,
  validateRecordReferences
} from "./validation-pipeline.js";

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
  return validateRecordWithManifest(
    config,
    draft,
    createManifestIndex(manifest.records),
    true
  );
}

/**
 * 读取并逐行校验 golden.jsonl 作者集。
 *
 * 文件级格式错误、重复 ID 与单条作者错误都保留在同一报告中；
 * 一个坏行不会阻断其他合法行的校验。结构、section、manifest 和关键词
 * 可达性按行汇总；PDF/schema 只读取并校验一次。
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
  const keywordResults: KeywordDiagnostic[] = [];
  const seenIds = new Map<string, number>();
  const index = createManifestIndex(manifest.records);
  const parsedRecords: Array<{
    record: Record<string, unknown>;
    line: number;
    id?: string;
  }> = [];

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

    parsedRecords.push({ record: parsed, line: lineNumber, ...(id ? { id } : {}) });
  }

  const pipeline = await runValidationPipeline(config, parsedRecords, index);
  for (const result of pipeline.records) {
    errors.push(...withLine(result.errors, result.line, result.id));
    warnings.push(...withLine(result.warnings, result.line, result.id));
    keywordResults.push(...result.keywordResults);
  }

  return createValidationReport({ errors, warnings, keywordResults });
}

/**
 * 在已读取 manifest 的前提下校验单条作者集记录。
 *
 * @param config 当前工作区配置。
 * @param input 待校验记录。
 * @param index manifest 文件身份与语义索引。
 * @param allowDraftId 是否接受 fin-D 草稿编号。
 * @returns 统一校验报告。
 */
async function validateRecordWithManifest(
  config: WorkspaceConfig,
  input: unknown,
  index: ManifestIndex,
  allowDraftId: boolean
): Promise<ValidationReport> {
  const schema = validateDraftSchema(input, { allowDraftId });
  if (!isRecord(input)) {
    return createValidationReport({ errors: schema.errors, warnings: schema.warnings });
  }
  const record = input;
  const evidence = selectValidEvidence(record.evidence);
  const loaded = await readEvidenceDocuments(config, evidence, index);
  const documents = new Map(
    loaded.successes.map(({ value, document }) => [
      resolvedFilePath(value, index),
      document
    ]).filter(([key]) => key !== undefined) as Array<[string, PdfEvidenceDocument]>
  );
  const errors: ValidationIssue[] = [];
  const readFailures = new Map(
    loaded.failures.map(({ value, error }) => [
      resolvedFilePath(value, index) ?? manifestFilePathKey(value.document_file_path ?? ""),
      error
    ])
  );
  const keywordResults = validateRecordReferences(
    record,
    evidence,
    index,
    documents,
    errors,
    readFailures
  );

  return createValidationReport({
    errors: [...schema.errors, ...errors],
    warnings: schema.warnings,
    keywordResults: attributeKeywordResults(
      record,
      evidence,
      (value) => resolvedFilePath(value, index),
      keywordResults
    )
  });
}

/**
 * 校验所有可定位 evidence 的来源 PDF，并保留文档索引。
 *
 * @param config 当前工作区配置。
 * @param evidence 合法 evidence 及其数组索引。
 * @param index manifest 文件身份与语义索引。
 * @returns 读取成功的来源文档。
 */
async function readEvidenceDocuments(
  config: WorkspaceConfig,
  evidence: ReadonlyArray<{ value: GoldenEvidence; index: number }>,
  index: ManifestIndex
): Promise<{
  successes: Array<{ value: GoldenEvidence; document: PdfEvidenceDocument }>;
  failures: Array<{ value: GoldenEvidence; index: number; error: unknown }>;
}> {
  const successes: Array<{ value: GoldenEvidence; document: PdfEvidenceDocument }> = [];
  const failures: Array<{ value: GoldenEvidence; index: number; error: unknown }> = [];
  for (const item of evidence) {
    const resolution = resolveEvidenceRecord(item.value, index);
    if (resolution.kind !== "resolved") continue;
    const manifestRecord = resolution.record;
    try {
      successes.push({
        value: item.value,
        document: await readPdfEvidence(config, manifestRecord.file_path)
      });
    } catch (error) {
      failures.push({ ...item, error });
    }
  }
  return { successes, failures };
}

/**
 * 获取 evidence 解析后的规范化文件身份。
 *
 * @param evidence 作者证据。
 * @param index manifest 索引。
 * @returns 规范化路径；无法唯一解析时为 undefined。
 */
function resolvedFilePath(
  evidence: GoldenEvidence,
  index: ManifestIndex
): string | undefined {
  const resolution = resolveEvidenceRecord(evidence, index);
  return resolution.kind === "resolved"
    ? manifestFilePathKey(resolution.record.file_path)
    : undefined;
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
