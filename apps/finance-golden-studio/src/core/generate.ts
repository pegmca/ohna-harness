import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GoldenStudioError } from "./errors.js";
import type { ManifestIndex } from "./evidence-resolution.js";
import {
  createManifestIndex,
  resolveEvidenceRecord,
  resolveLatestManifestRecord
} from "./evidence-resolution.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type { ManifestRecord } from "./manifest.js";
import { readManifest } from "./manifest.js";
import type { ValidationReport } from "./schema.js";
import { validateGolden } from "./validate.js";
import type {
  GoldenCase,
  GoldenResolution
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/** 生成器写入评测器的 PDF 字节信封。 */
export interface GenerateByteEnvelope {
  contentEncoding: "base64";
  contentBase64: string;
}

/** 生成器输出的文档形状，保持与 finance-api eval loader 契约一致。 */
export interface GeneratedDocument {
  source: string;
  fileName: string;
  content: GenerateByteEnvelope;
  sourceKind: "text" | "image";
  pageImageRef: string | null;
  bytes: number;
}

/** 生成器输出的单条评测 case。 */
export interface GeneratedEvalCase {
  id: string;
  query: string;
  mode: "rag" | "failure";
  documents: GeneratedDocument[];
  expectedSources: string[];
  expectedKeywords: string[];
  goldEvidence: string[];
  minCitations: number;
  tags: string[];
}

/** 生成器写出的数据集。 */
export interface GeneratedEvalDataset {
  schemaVersion: string;
  datasetVersion: string;
  generatedBy: {
    generator: string;
    version: string;
    source: string;
    note: string;
  };
  seed: number;
  domain: "finance";
  minCases: number;
  cases: GeneratedEvalCase[];
}

/** generate 工作流结果。 */
export interface GenerateReport {
  ok: boolean;
  caseCount: number;
  ragCount: number;
  failureCount: number;
  outputPath?: string;
  validation: ValidationReport;
  dataset: GeneratedEvalDataset;
}

/**
 * 将人工作者集映射为可被 finance-api eval loader 消费的数据集。
 *
 * 生成前先完整校验作者集；任何 ERROR 都直接返回失败报告且不写产物。
 * 非负例按 evidence 的稳定 `file_path` 身份读取 PDF 原始字节；仅声明的
 * latest_by 规则允许显式重算来源，绝不静默回退到同 ticker 的其他报告期。
 *
 * @param config 当前工作区配置。
 * @returns 生成统计、校验结果与数据集本身。
 */
export async function generateEvalDataset(
  config: WorkspaceConfig
): Promise<GenerateReport> {
  assertContainedPath(config.workspaceRoot, config.goldenPath);
  assertContainedPath(config.workspaceRoot, config.generatedPath);
  const validation = await validateGolden(config);
  if (!validation.ok) {
    return emptyReport(validation);
  }

  const golden = await readGolden(config);
  const manifest = await readManifest(config);
  if (manifest.errors.length > 0) {
    return emptyReport({
      ...validation,
      ok: false,
      errors: [...validation.errors, ...manifest.errors]
    });
  }
  const manifestIndex = createManifestIndex(manifest.records);
  const cases: GeneratedEvalCase[] = [];
  try {
    for (const goldenCase of golden) {
      cases.push(
        goldenCase.is_negative
          ? mapNegativeCase(goldenCase)
          : await mapRagCase(config, goldenCase, manifestIndex)
      );
    }
  } catch (error) {
    if (error instanceof GoldenStudioError) throw error;
    throw new GoldenStudioError(
      "evidence_not_found",
      `Evaluation dataset generation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }.`,
      { goldenPath: config.goldenPath },
      error
    );
  }

  const dataset = createDataset(cases);
  const serialized = `${JSON.stringify(dataset, null, 2)}\n`;
  await mkdir(dirname(config.generatedPath), { recursive: true });
  await writeFileAtomic(config.generatedPath, serialized);
  const ragCount = cases.filter((candidate) => candidate.mode === "rag").length;
  return {
    ok: true,
    caseCount: cases.length,
    ragCount,
    failureCount: cases.length - ragCount,
    outputPath: config.generatedPath,
    validation,
    dataset
  };
}

/**
 * 映射一条非负例，精确读取全部 evidence 文档。
 *
 * @param config 当前工作区配置。
 * @param goldenCase 作者集记录。
 * @param manifestIndex manifest 文件身份与语义索引。
 * @returns 评测 case。
 */
async function mapRagCase(
  config: WorkspaceConfig,
  goldenCase: GoldenCase,
  manifestIndex: ManifestIndex
): Promise<GeneratedEvalCase> {
  const sources = new Map<string, GeneratedDocument>();
  for (const evidence of goldenCase.evidence) {
    const resolved = resolveEvidence(
      evidence,
      goldenCase.resolution,
      manifestIndex
    );
    const source = resolved.file_path;
    if (sources.has(source)) continue;
    const absolutePath = resolve(config.corpusRoot, resolved.file_path);
    assertContainedPath(config.corpusRoot, absolutePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      throw new GoldenStudioError(
        "evidence_not_found",
        `Exact evidence source cannot be read: ${source}.`,
        { source, filePath: resolved.file_path },
        error
      );
    }
    sources.set(source, {
      source,
      fileName: resolved.file_path,
      content: {
        contentEncoding: "base64",
        contentBase64: bytes.toString("base64")
      },
      sourceKind: evidence.source_kind === "image" ? "image" : "text",
      pageImageRef: evidence.page_image_ref ?? null,
      bytes: bytes.byteLength
    });
  }

  const tags = new Set<string>([
    goldenCase.type,
    goldenCase.difficulty,
    ...(goldenCase.requires_multi_doc ? ["multi_doc"] : []),
    ...(goldenCase.snapshot_dependent ? ["snapshot_dependent"] : [])
  ]);
  return {
    id: goldenCase.id,
    query: goldenCase.query,
    mode: "rag",
    documents: [...sources.values()],
    expectedSources: [...sources.keys()],
    expectedKeywords: [...(goldenCase.expected_keywords ?? [])],
    goldEvidence: collectGoldEvidence(goldenCase),
    minCitations: 2,
    tags: [...tags]
  };
}

/**
 * 解析 evidence 对应 manifest 记录。
 *
 * @param evidence 作者集证据。
 * @param resolution 可选的显式时间解析规则。
 * @param manifestIndex manifest 文件身份与语义索引。
 * @returns 明确的 manifest 记录。
 */
function resolveEvidence(
  evidence: GoldenCase["evidence"][number],
  resolution: GoldenResolution | undefined,
  manifestIndex: ManifestIndex
): ManifestRecord {
  if (resolution?.type === "latest_by") {
    const expectedReport = `${evidence.report_type}/${evidence.period}`;
    if (expectedReport !== resolution.expected_report) {
      return exactManifestRecord(evidence, manifestIndex);
    }
    const ticker = resolutionScopeTicker(resolution.scope);
    if (ticker !== evidence.ticker) {
      throw new Error(
        `latest_by scope ticker ${ticker} does not match evidence ticker ${evidence.ticker}.`
      );
    }
    return latestManifestRecord(manifestIndex, evidence, resolution.variant);
  }
  return exactManifestRecord(evidence, manifestIndex);
}

/**
 * 读取 evidence 的精确 manifest 三元组；绝不按 ticker 回退。
 *
 * @param evidence 作者集证据。
 * @param manifestIndex manifest 文件身份与语义索引。
 * @returns 精确匹配记录。
 */
function exactManifestRecord(
  evidence: GoldenCase["evidence"][number],
  manifestIndex: ManifestIndex
): ManifestRecord {
  const exact = resolveEvidenceRecord(evidence, manifestIndex);
  if (exact.kind === "resolved") return exact.record;
  if (exact.kind === "ambiguous") {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `Evidence ${evidence.ticker}/${evidence.report_type}/${evidence.period} matches multiple documents: ${exact.candidateFilePaths.join(", ")}. Set document_file_path to select one.`,
      {
        reason: "evidence_source_ambiguous",
        ticker: evidence.ticker,
        report_type: evidence.report_type,
        period: evidence.period,
        candidate_file_paths: exact.candidateFilePaths,
        disambiguation_field: exact.disambiguationField
      }
    );
  }
  if (exact.kind === "selector_not_found") {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `Evidence document_file_path is not declared by the manifest: ${exact.filePath}.`,
      { reason: "selector_not_found", file_path: exact.filePath }
    );
  }
  if (exact.kind === "selector_mismatch") {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `Evidence document_file_path ${exact.filePath} has semantic fields ${exact.recordSemantic}, expected ${exact.semantic}.`,
      {
        reason: "selector_mismatch",
        file_path: exact.filePath,
        expected_semantic: exact.semantic,
        record_semantic: exact.recordSemantic
      }
    );
  }
  throw new GoldenStudioError(
    "evidence_parse_failed",
    `Exact manifest record not found for ${evidence.ticker}/${evidence.report_type}/${evidence.period}; refusing fallback.`,
    {
      reason: "evidence_not_in_manifest",
      ticker: evidence.ticker,
      report_type: evidence.report_type,
      period: evidence.period
    }
  );
}

/**
 * 提取 latest_by scope 中的 ticker。
 *
 * @param scope 作者规则 scope。
 * @returns ticker 文本。
 */
function resolutionScopeTicker(scope: string): string {
  const match = /^ticker=([^,;\s]+)$/u.exec(scope.trim());
  if (!match) {
    throw new Error(`Unsupported latest_by scope: ${scope}.`);
  }
  return match[1];
}

/**
 * 按披露日期选择最新记录；无法判定时不猜测。
 *
 * @param manifestIndex manifest 文件身份与语义索引。
 * @param evidence 期望报告类型/期。
 * @param variant 可选显式变体类。
 * @returns 最新记录。
 */
function latestManifestRecord(
  manifestIndex: ManifestIndex,
  evidence: GoldenCase["evidence"][number],
  variant?: string
): ManifestRecord {
  const latest = resolveLatestManifestRecord(
    manifestIndex,
    {
      ticker: evidence.ticker,
      report_type: evidence.report_type,
      period: evidence.period
    },
    variant
  );
  if (latest.kind === "resolved") return latest.record;
  if (latest.kind === "ambiguous") {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `latest_by is ambiguous for ${manifestSemanticLabel(evidence)} on ${latest.disclosureDate}: ${latest.candidateFilePaths.join(", ")}. Set resolution.variant to select one.`,
      {
        reason: "latest_by_ambiguous",
        ticker: evidence.ticker,
        report_type: evidence.report_type,
        period: evidence.period,
        disclosure_date: latest.disclosureDate,
        candidate_file_paths: latest.candidateFilePaths,
        disambiguation_field: latest.disambiguationField
      }
    );
  }
  if (latest.kind === "variant_not_found") {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `latest_by variant ${latest.variant} has no manifest records for ${manifestSemanticLabel(evidence)}.`,
      {
        reason: "latest_by_variant_not_found",
        ticker: latest.scope.ticker,
        variant: latest.variant
      }
    );
  }
  throw new GoldenStudioError(
    "evidence_parse_failed",
    `latest_by cannot resolve any manifest record for ${manifestSemanticLabel(evidence)}.`,
    {
      reason: latest.reason === "no_records" ? "latest_by_no_records" : "latest_by_no_disclosure_date",
      ticker: latest.scope.ticker,
      report_type: latest.scope.report_type,
      period: latest.scope.period
    }
  );
}

/**
 * 将 evidence 投影为错误消息中的可读语义标签。
 *
 * @param evidence 作者证据。
 * @returns ticker/report_type/period 文本。
 */
function manifestSemanticLabel(
  evidence: GoldenCase["evidence"][number]
): string {
  return `${evidence.ticker}/${evidence.report_type}/${evidence.period}`;
}

/**
 * 将作者金标准文本收集给 judge，不参与 expectedKeywords 推导。
 *
 * @param goldenCase 作者集记录。
 * @returns 人工真值文本。
 */
function collectGoldEvidence(goldenCase: GoldenCase): string[] {
  return [
    goldenCase.gold_answer,
    ...(goldenCase.gold_answer_table
      ? [tableToText(goldenCase.gold_answer_table)]
      : []),
    ...(goldenCase.gold_answer_form
      ? [formToText(goldenCase.gold_answer_form)]
      : []),
    ...goldenCase.evidence.flatMap((evidence) =>
      evidence.quote ? [evidence.quote] : []
    )
  ];
}

/**
 * 将表格真值投影为 judge 文本。
 *
 * @param table 作者表格。
 * @returns 换行分隔文本。
 */
function tableToText(table: NonNullable<GoldenCase["gold_answer_table"]>): string {
  return [
    table.columns.join(" / "),
    ...table.rows.map((row) => row.join(" / "))
  ].join("\n");
}

/**
 * 将表单真值投影为 judge 文本。
 *
 * @param form 作者表单。
 * @returns 换行分隔文本。
 */
function formToText(form: NonNullable<GoldenCase["gold_answer_form"]>): string {
  return form.items.map((item) => `${item.key}=${item.value}`).join("\n");
}

/**
 * 将反例题映射为 failure case。
 *
 * @param goldenCase 反例作者记录。
 * @returns failure case。
 */
function mapNegativeCase(goldenCase: GoldenCase): GeneratedEvalCase {
  return {
    id: goldenCase.id,
    query: goldenCase.query,
    mode: "failure",
    documents: [],
    expectedSources: [],
    expectedKeywords: [],
    goldEvidence: [goldenCase.gold_answer],
    minCitations: 0,
    tags: ["negative", goldenCase.type, goldenCase.difficulty]
  };
}

/**
 * 创建评测数据集外层信封。
 *
 * @param cases 生成 case。
 * @returns 可持久化数据集。
 */
function createDataset(cases: GeneratedEvalCase[]): GeneratedEvalDataset {
  return {
    schemaVersion: "2.0.0",
    datasetVersion: "finance-rag-golden-v1.0.0",
    generatedBy: {
      generator: "apps/finance-golden-studio/src/core/generate.ts",
      version: "1.0.0",
      source: "datasets/finance/rag-golden/golden.jsonl",
      note: "Human-authored expected_keywords and explicit file_path/variant source selectors; latest_by is disclosure-date unique without line-order fallback."
    },
    seed: 20261027,
    domain: "finance",
    minCases: 1,
    cases
  };
}

/**
 * 读取并解析 golden.jsonl。
 *
 * @param config 当前工作区配置。
 * @returns 作者集记录。
 */
async function readGolden(config: WorkspaceConfig): Promise<GoldenCase[]> {
  const raw = await readFile(config.goldenPath, "utf8");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldenCase);
}

/**
 * 创建失败报告，保持 case 数量为零且不包含 outputPath。
 *
 * @param validation 校验报告。
 * @returns 失败 GenerateReport。
 */
function emptyReport(validation: ValidationReport): GenerateReport {
  return {
    ok: false,
    caseCount: 0,
    ragCount: 0,
    failureCount: 0,
    validation,
    dataset: createDataset([])
  };
}
