import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile } from "./backups.js";
import { listDrafts, readDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import { writeFileAtomic } from "./fs-atomic.js";
import {
  commitPublications,
  planPublications,
  publicationLedgerPath,
  recoverPublications,
  type PublicationStore
} from "./publications.js";
import type { ValidationReport } from "./schema.js";
import { createValidationReport } from "./schema-report.js";
import type { GoldenCase, GoldenDraft } from "./types.js";
import { validateGolden } from "./validate.js";
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
  publicationLedgerPath?: string;
}

/** promote 的可注入写入边界，默认使用正式原子写入器。 */
export interface PromoteOptions {
  writeGolden?: (path: string, content: string) => Promise<void>;
  writeLedger?: (path: string, content: string) => Promise<void>;
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
  batch: string,
  options: PromoteOptions = {}
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
  if (drafts.length === 0) {
    return {
      ok: true,
      batch,
      approvedCount: 0,
      promotedCount: 0,
      pendingCount,
      promoted: [],
      validation: createValidationReport()
    };
  }

  const ledgerPath = publicationLedgerPath(config);
  const ledger = await recoverPublications(
    config,
    existing,
    publicationStore(options)
  );
  const next = planPublications(existing, drafts, batch, ledger);
  const validation = await validateFinalAuthoringSet(config, next.records);
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
  if (next.promoted.length === 0 && next.reused.length > 0) {
    return {
      ok: true,
      batch,
      approvedCount: drafts.length,
      promotedCount: 0,
      pendingCount,
      promoted: next.reused,
      validation,
      ...(ledgerPath ? { publicationLedgerPath: ledgerPath } : {})
    };
  }
  const backupPath = existsSync(config.goldenPath)
    ? await backupFile(config, config.goldenPath, "before-promote")
    : undefined;
  await commitPublications(config, next.records, next.ledger, {
    ...publicationStore(options),
    ...(options.writeGolden ? { golden: options.writeGolden } : {})
  });

  return {
    ok: true,
    batch,
    approvedCount: drafts.length,
    promotedCount: next.promoted.length,
    pendingCount,
    promoted: next.promoted,
    validation,
    ...(backupPath ? { backupPath } : {}),
    publicationLedgerPath: ledgerPath
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
 * 校验完整候选作者集（既有记录 + 已分配 ID 的新草稿）。
 *
 * 使用临时工作区文件复用 validateGolden，使所有结构、精确引用、关键词、
 * ID 唯一性和现有 schema 规则在备份与正式写入前一次生效。
 *
 * @param config 当前工作区配置。
 * @param records 待成为新 golden.jsonl 的完整记录。
 * @returns 完整作者集校验报告。
 */
async function validateFinalAuthoringSet(
  config: WorkspaceConfig,
  records: readonly GoldenCase[]
): Promise<ValidationReport> {
  const tempRoot = await mkdtemp(join(tmpdir(), "golden-promote-"));
  const canonicalRoot = await realpath(tempRoot);
  const goldenPath = join(canonicalRoot, "golden.jsonl");
  try {
    await writeFile(goldenPath, serializeGolden(records), "utf8");
    return validateGolden({
      ...config,
      repoRoot: canonicalRoot,
      workspaceRoot: canonicalRoot,
      goldenPath
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
 * 将可注入的账本写入器适配为 publication store。
 *
 * @param options promote 写入选项。
 * @returns 账本写入边界。
 */
function publicationStore(options: PromoteOptions): PublicationStore {
  return options.writeLedger ? { write: options.writeLedger } : {};
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
