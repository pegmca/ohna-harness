import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GoldenStudioError } from "./errors.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestTripleKey, readManifest } from "./manifest.js";
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
 * 非负例按 evidence 的精确三元组读取 PDF 原始字节；仅声明的 latest_by
 * 规则允许显式重算来源，绝不静默回退到同 ticker 的其他报告期。
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
  const byTriple = new Map(
    manifest.records.map((record) => [manifestTripleKey(record), record])
  );
  const recordsByTicker = groupManifestByTicker(manifest.records);
  const cases: GeneratedEvalCase[] = [];
  try {
    for (const goldenCase of golden) {
      cases.push(
        goldenCase.is_negative
          ? mapNegativeCase(goldenCase)
          : await mapRagCase(config, goldenCase, byTriple, recordsByTicker)
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
 * @param byTriple manifest 精确索引。
 * @param recordsByTicker latest_by 的显式规则索引。
 * @returns 评测 case。
 */
async function mapRagCase(
  config: WorkspaceConfig,
  goldenCase: GoldenCase,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  recordsByTicker: ReadonlyMap<string, readonly ManifestRecord[]>
): Promise<GeneratedEvalCase> {
  const sources = new Map<string, GeneratedDocument>();
  for (const evidence of goldenCase.evidence) {
    const resolved = resolveEvidence(
      evidence,
      goldenCase.resolution,
      byTriple,
      recordsByTicker
    );
    const source = `${resolved.ticker}/${resolved.report_type}/${resolved.period}`;
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
      fileName: `${source}.pdf`,
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
 * @param byTriple 精确 manifest 索引。
 * @param recordsByTicker latest_by 索引。
 * @returns 明确的 manifest 记录。
 */
function resolveEvidence(
  evidence: GoldenCase["evidence"][number],
  resolution: GoldenResolution | undefined,
  byTriple: ReadonlyMap<string, ManifestRecord>,
  recordsByTicker: ReadonlyMap<string, readonly ManifestRecord[]>
): ManifestRecord {
  if (resolution?.type === "latest_by") {
    const expectedReport = `${evidence.report_type}/${evidence.period}`;
    if (expectedReport !== resolution.expected_report) {
      return exactManifestRecord(evidence, byTriple);
    }
    const ticker = resolutionScopeTicker(resolution.scope);
    if (ticker !== evidence.ticker) {
      throw new Error(
        `latest_by scope ticker ${ticker} does not match evidence ticker ${evidence.ticker}.`
      );
    }
    const latest = latestManifestRecord(ticker, recordsByTicker.get(ticker) ?? []);
    if (!latest) {
      throw new Error(`latest_by cannot resolve any manifest record for ${ticker}.`);
    }
    return latest;
  }
  return exactManifestRecord(evidence, byTriple);
}

/**
 * 读取 evidence 的精确 manifest 三元组；绝不按 ticker 回退。
 *
 * @param evidence 作者集证据。
 * @param byTriple 精确 manifest 索引。
 * @returns 精确匹配记录。
 */
function exactManifestRecord(
  evidence: GoldenCase["evidence"][number],
  byTriple: ReadonlyMap<string, ManifestRecord>
): ManifestRecord {
  const exact = byTriple.get(manifestTripleKey(evidence));
  if (!exact) {
    throw new Error(
      `Exact manifest triple not found for ${evidence.ticker}/${evidence.report_type}/${evidence.period}; refusing fallback.`
    );
  }
  return exact;
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
 * @param records 同 ticker manifest 记录。
 * @returns 最新记录或 undefined。
 */
function latestManifestRecord(
  ticker: string,
  records: readonly ManifestRecord[]
): ManifestRecord | undefined {
  const dated = records.filter(
    (record): record is ManifestRecord & { disclosure_date: string } =>
      typeof record.disclosure_date === "string" &&
      record.disclosure_date.trim().length > 0
  );
  if (dated.length === 0) return undefined;
  const maximumDate = dated.reduce(
    (maximum, record) =>
      record.disclosure_date > maximum ? record.disclosure_date : maximum,
    dated[0].disclosure_date
  );
  const newest = dated.filter(
    (record) => record.disclosure_date === maximumDate
  );
  if (newest.length > 1) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `latest_by is ambiguous for ${ticker} on ${maximumDate}.`,
      {
        reason: "latest_by_ambiguous",
        ticker,
        disclosure_date: maximumDate,
        sources: newest.map((record) =>
          `${record.ticker}/${record.report_type}/${record.period}`
        )
      }
    );
  }
  return newest[0];
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
      note: "Human-authored expected_keywords and exact evidence triples; latest_by is explicit."
    },
    seed: 20261027,
    domain: "finance",
    minCases: 1,
    cases
  };
}

/**
 * 按 ticker 索引 manifest。
 *
 * @param records manifest 记录。
 * @returns ticker 到记录列表。
 */
function groupManifestByTicker(
  records: readonly ManifestRecord[]
): Map<string, ManifestRecord[]> {
  const grouped = new Map<string, ManifestRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.ticker) ?? [];
    list.push(record);
    grouped.set(record.ticker, list);
  }
  return grouped;
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
