import { listDrafts, readDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import type {
  DraftBatchValidationResult,
  DraftScopedValidationResult,
  ValidationReport
} from "./types.js";
import { createValidationReport } from "./schema-report.js";
import { validateDraft } from "./validate.js";
import type { WorkspaceConfig } from "./workspace.js";

export type { DraftBatchValidationResult, DraftScopedValidationResult };

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
  const reports: DraftValidationReport[] = [];
  for (const summary of summaries) {
    if (summary.corrupt) {
      throw new GoldenStudioError(
        "draft_corrupt",
        `Batch ${batch} contains corrupt draft ${summary.id}.`,
        { batch, id: summary.id }
      );
    }
    const draft = await readDraft(config, batch, summary.id);
    reports.push({
      id: summary.id,
      report: await validateDraft(config, draft)
    });
  }
  return {
    batch,
    draftCount: summaries.length,
    validation: mergeReports(reports)
  };
}

/** 带来源草稿 ID 的单草稿校验结果。 */
interface DraftValidationReport {
  id: string;
  report: ValidationReport;
}

/**
 * 校验批次中的当前草稿，为 Web 审批提供无跨草稿归因的权威报告。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @param id 当前草稿 ID。
 * @returns 仅包含当前草稿问题的校验信封。
 */
export async function validateDraftDraft(
  config: WorkspaceConfig,
  batch: string,
  id: string
): Promise<DraftScopedValidationResult> {
  const draft = await readDraft(config, batch, id);
  return {
    batch,
    id,
    validation: await validateDraft(config, draft)
  };
}

/**
 * 合并多个草稿校验报告，并为每条问题标记所属草稿 ID。
 *
 * 保持 ValidationReport 的扁平形状；CLI、HTTP 与 Web 都从同一
 * issue.id 读取归因，不引入额外的嵌套报告结构。
 *
 * @param reports 带草稿 ID 的单草稿报告。
 * @returns 统一 ValidationReport。
 */
function mergeReports(
  reports: readonly DraftValidationReport[]
): ValidationReport {
  const errors = reports.flatMap(({ id, report }) =>
    report.errors.map((candidate) => ({ ...candidate, id }))
  );
  const warnings = reports.flatMap(({ id, report }) =>
    report.warnings.map((candidate) => ({ ...candidate, id }))
  );
  const keywordResults = reports.flatMap(({ report }) => report.keywordResults);
  return createValidationReport({ errors, warnings, keywordResults });
}
