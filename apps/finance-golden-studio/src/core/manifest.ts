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
  file_path: string;
}

/** manifest 读取结果；损坏行保留为诊断而不是静默跳过。 */
export interface ManifestReadResult {
  records: ManifestRecord[];
  errors: ValidationIssue[];
}

/**
 * 读取并校验 manifest.jsonl，建立 ticker/report_type/period 索引。
 *
 * 任何坏行都会使引用检查 fail-closed；即使其他行可解析，也绝不把
 * “manifest 不完整”误报成 evidence 不存在。重复三元组同样报错，
 * 因为来源 PDF 必须唯一。
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
  const triples = new Map<string, number>();
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
    const key = tripleKey(record);
    const firstLine = triples.get(key);
    if (firstLine !== undefined) {
      errors.push({
        ...issue(
          "manifest_triple_duplicate",
          `manifest triple ${key} is duplicated (lines ${firstLine}, ${lineNumber}).`
        ),
        line: lineNumber
      });
      return;
    }
    triples.set(key, lineNumber);
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
    value.file_path.trim().length === 0
  ) {
    return undefined;
  }
  return {
    ticker: value.ticker,
    report_type: value.report_type,
    period: value.period,
    file_path: value.file_path
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
