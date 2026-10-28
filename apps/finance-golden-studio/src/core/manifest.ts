import { readFile } from "node:fs/promises";
import type { ValidationIssue } from "./schema.js";
import { isRecord, issue } from "./schema.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/** manifest 中用于精确定位来源 PDF 的最小记录。 */
export interface ManifestRecord {
  ticker: string;
  report_type: string;
  period: string;
  /** 语料根内的稳定文件身份；同三元组的 A/H 变体以不同路径共存。 */
  file_path: string;
  /** 可选显式变体类，如 a / h；不根据标题在运行时猜测。 */
  variant?: string;
  /** 来源披露语言；manifest 已有字段，只作为文档元数据保留。 */
  language?: string;
  /** 来源 URL；只作为文档元数据保留，不用于语义消歧。 */
  source_url?: string;
  /** 来源标题；只作为文档元数据保留，不用于 H 股启发式判断。 */
  title?: string;
  /** latest_by 时间路由所需的披露日期；缺失时不得猜测最新文件。 */
  disclosure_date?: string;
}

/** ticker 语义键的来源字段。 */
export type ManifestTickerKey = Pick<ManifestRecord, "ticker">;

/** manifest 读取结果；损坏行保留为诊断而不是静默跳过。 */
export interface ManifestReadResult {
  records: ManifestRecord[];
  errors: ValidationIssue[];
}

/**
 * 读取并校验 manifest.jsonl，保留语义三元组并接受同三元组变体。
 *
 * 任何坏行都会使引用检查 fail-closed；即使其他行可解析，也绝不把
 * “manifest 不完整”误报成 evidence 不存在。`file_path` 必须是唯一
 * 文档身份；ticker/report_type/period 只是语义字段，允许 A/H 等变体
 * 共享同一三元组。
 *
 * @param config 当前工作区配置。
 * @returns 合法记录与 manifest 级问题。
 */
export async function readManifest(config: WorkspaceConfig): Promise<ManifestReadResult> {
  assertContainedPath(config.corpusRoot, config.manifestPath);
  let raw: string;
  try {
    raw = await readFile(config.manifestPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return {
        records: [],
        errors: [
          issue(
            "manifest_not_found",
            `Corpus manifest not found: ${config.manifestPath}.`
          )
        ]
      };
    }
    return {
      records: [],
      errors: [
        issue(
          "manifest_record_invalid",
          `Corpus manifest cannot be read: ${config.manifestPath}.`
        )
      ]
    };
  }

  const records: ManifestRecord[] = [];
  const errors: ValidationIssue[] = [];
  const filePaths = new Map<string, number>();
  const lines = raw.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({
        ...issue(
          "manifest_json_invalid",
          `manifest line ${lineNumber} is not valid JSON: ${errorMessage(error)}.`
        ),
        line: lineNumber
      });
      return;
    }
    const record = parseManifestRecord(parsed);
    if (!record) {
      errors.push({
        ...issue(
          "manifest_record_invalid",
          `manifest line ${lineNumber} requires string ticker/report_type/period/file_path.`
        ),
        line: lineNumber
      });
      return;
    }
    const key = manifestFilePathKey(record.file_path);
    const firstLine = filePaths.get(key);
    if (firstLine !== undefined) {
      errors.push({
        ...issue(
          "manifest_file_path_duplicate",
          `manifest file_path ${record.file_path} is duplicated (lines ${firstLine}, ${lineNumber}).`
        ),
        line: lineNumber
      });
      return;
    }
    filePaths.set(key, lineNumber);
    records.push(record);
  });

  return { records, errors };
}

/**
 * 返回 manifest 三元组的稳定索引键。
 *
 * @param record 待索引来源。
 * @returns ticker/report_type/period 键。
 */
export function manifestTripleKey(
  record: Pick<ManifestRecord, "ticker" | "report_type" | "period">
): string {
  return tripleKey(record);
}

/**
 * 返回 evidence 与 manifest 共用的语义三元组键。
 *
 * @param record 语义字段。
 * @returns 可读的稳定键。
 */
export function manifestSemanticKey(
  record: Pick<ManifestRecord, "ticker" | "report_type" | "period">
): string {
  return tripleKey(record);
}

/**
 * 返回 manifest 文件身份键，斜杠方向不影响相同路径。
 *
 * @param filePath 语料相对路径。
 * @returns 可比较的规范化路径键。
 */
export function manifestFilePathKey(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/");
}

/**
 * 将未知 manifest 行收窄为来源记录。
 *
 * @param value 解析后的 JSON 值。
 * @returns 合法记录；否则 undefined。
 */
function parseManifestRecord(value: unknown): ManifestRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.ticker !== "string" ||
    typeof value.report_type !== "string" ||
    typeof value.period !== "string" ||
    typeof value.file_path !== "string" ||
    value.ticker.trim().length === 0 ||
    value.report_type.trim().length === 0 ||
    value.period.trim().length === 0 ||
    value.file_path.trim().length === 0 ||
    (value.variant !== undefined &&
      (typeof value.variant !== "string" || value.variant.trim().length === 0)) ||
    (value.language !== undefined &&
      (typeof value.language !== "string" || value.language.trim().length === 0)) ||
    (value.source_url !== undefined &&
      (typeof value.source_url !== "string" ||
        value.source_url.trim().length === 0)) ||
    (value.title !== undefined &&
      (typeof value.title !== "string" || value.title.trim().length === 0))
  ) {
    return undefined;
  }
  const meta = isRecord(value.meta) ? value.meta : undefined;
  return {
    ticker: value.ticker,
    report_type: value.report_type,
    period: value.period,
    file_path: value.file_path,
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
    ...(typeof value.source_url === "string"
      ? { source_url: value.source_url }
      : {}),
    ...(typeof value.title === "string" && value.title.trim().length > 0
      ? { title: value.title }
      : typeof meta?.title === "string" && meta.title.trim().length > 0
        ? { title: meta.title }
        : {}),
    ...(typeof value.disclosure_date === "string" &&
    value.disclosure_date.trim().length > 0
      ? { disclosure_date: value.disclosure_date }
      : {})
  };
}

/**
 * 拼接来源三元组。
 *
 * @param record 来源标识字段。
 * @returns 单义字符串键。
 */
function tripleKey(
  record: Pick<ManifestRecord, "ticker" | "report_type" | "period">
): string {
  return `${record.ticker}\u0000${record.report_type}\u0000${record.period}`;
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

/**
 * 安全提取异常消息。
 *
 * @param error 捕获值。
 * @returns 可展示说明。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown parse error";
}
