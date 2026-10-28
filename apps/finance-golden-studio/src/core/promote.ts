import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { backupFile } from "./backups.js";
import { listDrafts, readDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type { ValidationIssue, ValidationReport } from "./schema.js";
import { createValidationReport } from "./schema-report.js";
import type { GoldenCase, GoldenDraft } from "./types.js";
import { validateDraft } from "./validate.js";
import type { WorkspaceConfig } from "./workspace.js";
import {
  assertContainedPath,
  validateBatchName
} from "./workspace.js";

/** 单条草稿发布结果。 */
export interface PromotedDraft {
  draftId: string;
  goldenId: string;
}

/** promote 工作流结果。 */
export interface PromoteReport {
  ok: boolean;
  batch: string;
  approvedCount: number;
  promotedCount: number;
  pendingCount: number;
  promoted: PromotedDraft[];
  validation: ValidationReport;
  backupPath?: string;
}

/**
 * 将一个批次中所有审核通过且校验成功的草稿追加进作者集。
 *
 * 先读取并校验全部审核草稿，任一失败则整批零写入、零备份。
 * 全部成功后先备份现存 golden.jsonl，再用同目录原子替换写入完整结果。
 *
 * @param config 当前工作区配置。
 * @param batch 待发布批次。
 * @returns 发布统计、校验报告与备份路径。
 */
export async function promoteBatch(
  config: WorkspaceConfig,
  batch: string
): Promise<PromoteReport> {
  validateBatchName(batch);
  assertContainedPath(config.workspaceRoot, config.goldenPath);
  assertContainedPath(config.workspaceRoot, config.backupRoot);
  const summaries = await listDrafts(config, batch);
  const corrupt = summaries.filter((summary) => summary.corrupt);
  if (corrupt.length > 0) {
    throw new GoldenStudioError(
      "draft_corrupt",
      `Batch ${batch} contains corrupt drafts; promotion cannot proceed.`,
      { batch, ids: corrupt.map((summary) => summary.id) }
    );
  }
  const approved = summaries.filter((summary) => summary.approved);
  const pendingCount = summaries.filter(
    (summary) => !summary.approved && !summary.corrupt
  ).length;
  const existing = await readExistingGolden(config);
  const drafts = await readPromotableDrafts(config, batch, approved);
  const reports = await validateBatch(config, drafts);
  const validation = mergeReports(reports);

  if (!validation.ok) {
    return {
      ok: false,
      batch,
      approvedCount: approved.length,
      promotedCount: 0,
      pendingCount,
      promoted: [],
      validation
    };
  }

  if (drafts.length === 0) {
    return {
      ok: true,
      batch,
      approvedCount: 0,
      promotedCount: 0,
      pendingCount,
      promoted: [],
      validation
    };
  }

  const next = assignGoldenIds(existing, drafts);
  const backupPath = existsSync(config.goldenPath)
    ? await backupFile(config, config.goldenPath, "before-promote")
    : undefined;
  const content = serializeGolden(next.records);
  await writeFileAtomic(config.goldenPath, content);

  return {
    ok: true,
    batch,
    approvedCount: drafts.length,
    promotedCount: next.promoted.length,
    pendingCount,
    promoted: next.promoted,
    validation,
    ...(backupPath ? { backupPath } : {})
  };
}

/**
 * 读取审核草稿；任一损坏草稿都转为批次级错误。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @param summaries 审核草稿摘要。
 * @returns 完整草稿列表。
 */
async function readPromotableDrafts(
  config: WorkspaceConfig,
  batch: string,
  summaries: Awaited<ReturnType<typeof listDrafts>>
): Promise<GoldenDraft[]> {
  const drafts: GoldenDraft[] = [];
  for (const summary of summaries) {
    drafts.push(await readDraft(config, batch, summary.id));
  }
  return drafts;
}

/**
 * 校验全部审核草稿并补充批次内重复 ID 诊断。
 *
 * @param config 当前工作区配置。
 * @param drafts 待发布草稿。
 * @returns 每份草稿的校验报告。
 */
async function validateBatch(
  config: WorkspaceConfig,
  drafts: readonly GoldenDraft[]
): Promise<Array<{ id: string; report: ValidationReport }>> {
  const seen = new Set<string>();
  const results = [];
  for (const draft of drafts) {
    const report = await validateDraft(config, draft);
    if (seen.has(draft.id)) {
      report.errors.push({
        code: "golden_id_duplicate",
        message: `Draft id ${draft.id} appears more than once in the approved batch.`,
        id: draft.id,
        field: "id"
      });
      report.ok = false;
    }
    seen.add(draft.id);
    results.push({ id: draft.id, report });
  }
  return results;
}

/**
 * 合并批次校验报告并为每条问题补充草稿 ID。
 *
 * @param reports 按草稿归集的校验报告。
 * @returns 统一 ValidationReport。
 */
function mergeReports(
  reports: ReadonlyArray<{ id: string; report: ValidationReport }>
): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const keywordResults = [];
  for (const { id, report } of reports) {
    errors.push(...report.errors.map((entry) => ({ ...entry, id: entry.id ?? id })));
    warnings.push(...report.warnings.map((entry) => ({ ...entry, id: entry.id ?? id })));
    keywordResults.push(...report.keywordResults);
  }
  return createValidationReport({ errors, warnings, keywordResults });
}

/**
 * 读取现存作者集；不存在时视为空列表。
 *
 * @param config 当前工作区配置。
 * @returns 已解析的 golden records。
 */
async function readExistingGolden(config: WorkspaceConfig): Promise<GoldenCase[]> {
  let raw: string;
  try {
    raw = await readFile(config.goldenPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new GoldenStudioError(
          "draft_corrupt",
          `Existing golden line ${index + 1} is invalid JSON.`,
          { goldenPath: config.goldenPath, line: index + 1 },
          error
        );
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new GoldenStudioError(
          "draft_corrupt",
          `Existing golden line ${index + 1} must be an object.`,
          { goldenPath: config.goldenPath, line: index + 1 }
        );
      }
      return value as GoldenCase;
    });
}

/**
 * 为审核草稿分配连续 fin-NNN ID 并剔除 `_draft`。
 *
 * @param existing 现存作者集。
 * @param drafts 已通过校验的草稿。
 * @returns 完整作者集与新发布映射。
 */
function assignGoldenIds(
  existing: readonly GoldenCase[],
  drafts: readonly GoldenDraft[]
): { records: GoldenCase[]; promoted: PromotedDraft[] } {
  let maximum = maximumGoldenNumber(existing);
  const records = [...existing];
  const promoted: PromotedDraft[] = [];
  for (const draft of drafts) {
    maximum += 1;
    const goldenId = `fin-${String(maximum).padStart(3, "0")}`;
    const { _draft: ignored, ...authoring } = draft;
    void ignored;
    records.push({ ...authoring, id: goldenId });
    promoted.push({ draftId: draft.id, goldenId });
  }
  return { records, promoted };
}

/**
 * 提取现存作者集最大 fin 编号。
 *
 * @param records 现存记录。
 * @returns 最大数字；无匹配记录时为 0。
 */
function maximumGoldenNumber(records: readonly GoldenCase[]): number {
  let maximum = 0;
  for (const record of records) {
    const match = /^fin-(\d+)$/u.exec(record.id ?? "");
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum;
}

/**
 * 将作者集写成单行 JSONL。
 *
 * @param records 作者集记录。
 * @returns 带末尾换行的文本。
 */
function serializeGolden(records: readonly GoldenCase[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
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
