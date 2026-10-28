import { listDrafts, readDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import type {
  DraftBatchValidationResult,
  ValidationReport
} from "./types.js";
import { validateDraft } from "./validate.js";
import type { WorkspaceConfig } from "./workspace.js";

export type { DraftBatchValidationResult };

/**
 * 枚举批次草稿、逐条读取校验并合并为批次报告。
 *
 * 编排归 core 所有，CLI/server 只负责输入边界与结果投影；损坏草稿
 * 以结构化错误 fail-closed，不静默跳过。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @returns 批次校验信封。
 */
export async function validateDraftBatch(
  config: WorkspaceConfig,
  batch: string
): Promise<DraftBatchValidationResult> {
  const summaries = await listDrafts(config, batch);
  if (summaries.length === 0) {
    throw new GoldenStudioError(
      "drafts_not_found",
      `Draft batch not found or empty: ${batch}.`,
      { batch }
    );
  }
  const reports: ValidationReport[] = [];
  for (const summary of summaries) {
    if (summary.corrupt) {
      throw new GoldenStudioError(
        "draft_corrupt",
        `Batch ${batch} contains corrupt draft ${summary.id}.`,
        { batch, id: summary.id }
      );
    }
    const draft = await readDraft(config, batch, summary.id);
    reports.push(await validateDraft(config, draft));
  }
  return {
    batch,
    draftCount: summaries.length,
    validation: mergeReports(reports)
  };
}

/**
 * 合并多个草稿校验报告。
 *
 * @param reports 单草稿报告。
 * @returns 统一 ValidationReport。
 */
function mergeReports(reports: readonly ValidationReport[]): ValidationReport {
  const errors = reports.flatMap((report) => report.errors);
  const warnings = reports.flatMap((report) => report.warnings);
  const keywordResults = reports.flatMap((report) => report.keywordResults);
  return { ok: errors.length === 0, errors, warnings, keywordResults };
}
