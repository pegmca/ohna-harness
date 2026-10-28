import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parsePdfBlocks } from "@aiagent/parsing";
import { saveDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import { assessExtractionHealth } from "./extraction-health.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestTripleKey, readManifest } from "./manifest.js";
import {
  buildMineDraft,
  buildNegativeDraft,
  validateMineCandidate
} from "./mine-draft.js";
import type { MineCandidate } from "./mine-draft.js";
import type { GoldenDraft } from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import {
  assertContainedPath,
  validateBatchName,
  WorkspaceError
} from "./workspace.js";

export type { MineCandidate } from "./mine-draft.js";

/** mine 的批次与候选输入。 */
export interface MineInput {
  batch: string;
  candidates: readonly MineCandidate[];
}

/** 未能生成草稿的候选及稳定原因。 */
export interface MineSkip {
  candidate: MineCandidate;
  id: string;
  reason:
    | "batch_exists"
    | "evidence_not_in_manifest"
    | "evidence_not_found"
    | "evidence_parse_failed"
    | "text_too_short"
    | "cjk_spacing"
    | "extraction_too_short"
    | "invalid_candidate";
  message: string;
}

/** mine 工作流结果。 */
export interface MineReport {
  ok: boolean;
  complete: boolean;
  batch: string;
  draftedCount: number;
  skippedCount: number;
  drafts: GoldenDraft[];
  skipped: MineSkip[];
}

/**
 * 从精确定位的 PDF 生成待人工补全的候选草稿。
 *
 * 候选条目通过现有草稿仓库原子保存。来源三元组缺失、PDF 缺失或抽取文本
 * 过短都作为显式跳过项返回，不借用同 ticker 的其他文件。
 *
 * @param config 当前工作区配置。
 * @param input 批次名与候选列表。
 * @returns 已写草稿与跳过诊断。
 */
export async function mineCandidates(
  config: WorkspaceConfig,
  input: MineInput
): Promise<MineReport> {
  validateBatchName(input.batch);
  assertContainedPath(config.workspaceRoot, config.draftRoot);
  const manifest = await readManifest(config);
  if (manifest.errors.length > 0) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      "Corpus manifest is invalid; mining cannot resolve exact sources.",
      { errors: manifest.errors, manifestPath: config.manifestPath }
    );
  }
  const byTriple = new Map(
    manifest.records.map((record) => [manifestTripleKey(record), record])
  );
  const tickers = new Set(manifest.records.map((record) => record.ticker));
  const drafts: GoldenDraft[] = [];
  const skipped: MineSkip[] = [];

  const collision = await findBatchCollision(config, input.batch);
  if (collision) {
    return {
      ok: false,
      complete: false,
      batch: input.batch,
      draftedCount: 0,
      skippedCount: 1,
      drafts: [],
      skipped: [
        {
          candidate: input.candidates[0] ?? emptyCandidate(),
          id: "fin-D001",
          reason: "batch_exists",
          message: collision
        }
      ]
    };
  }

  for (const [index, candidate] of input.candidates.entries()) {
    const id = `fin-D${String(index + 1).padStart(3, "0")}`;
    const invalid = validateMineCandidate(candidate);
    if (invalid) {
      skipped.push({ candidate, id, reason: "invalid_candidate", message: invalid });
      continue;
    }

    if (candidate.type === "negative") {
      if (tickers.has(candidate.ticker)) {
        skipped.push({
          candidate,
          id,
          reason: "invalid_candidate",
          message: `Negative candidate ${candidate.ticker} already exists in the corpus manifest.`
        });
        continue;
      }
      drafts.push(buildNegativeDraft(candidate, id));
      continue;
    }

    const record = byTriple.get(manifestTripleKey(candidate));
    if (!record) {
      skipped.push({
        candidate,
        id,
        reason: "evidence_not_in_manifest",
        message: `Exact manifest triple not found: ${manifestTripleKey(candidate)}.`
      });
      continue;
    }

    try {
      const result = await buildCandidateDraft(config, candidate, record, id);
      if ("reason" in result) {
        skipped.push({ candidate, id, ...result });
        continue;
      }
      drafts.push(result);
    } catch (error) {
      const mapped = mapEvidenceError(error, candidate, id);
      skipped.push(mapped);
    }
  }

  if (skipped.length > 0) {
    return {
      ok: false,
      complete: false,
      batch: input.batch,
      draftedCount: 0,
      skippedCount: skipped.length,
      drafts: [],
      skipped
    };
  }

  const savedDrafts: GoldenDraft[] = [];
  for (const draft of drafts) {
    const saved = await saveDraft(config, input.batch, draft.id, draft);
    savedDrafts.push(saved.draft);
  }
  return {
    ok: true,
    complete: savedDrafts.length > 0,
    batch: input.batch,
    draftedCount: savedDrafts.length,
    skippedCount: 0,
    drafts: savedDrafts,
    skipped
  };
}

/**
 * 构建非负例候选草稿。
 *
 * @param config 当前工作区配置。
 * @param candidate 候选定义。
 * @param record 精确 manifest 记录。
 * @param id 草稿 ID。
 * @returns 草稿或抽取跳过原因。
 */
async function buildCandidateDraft(
  config: WorkspaceConfig,
  candidate: MineCandidate,
  record: ManifestRecord,
  id: string
): Promise<GoldenDraft | Omit<MineSkip, "candidate" | "id">> {
  const absolutePath = join(config.corpusRoot, record.file_path);
  assertContainedPath(config.corpusRoot, absolutePath);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw new GoldenStudioError(
      "evidence_not_found",
      `Candidate PDF cannot be read: ${record.file_path}.`,
      { filePath: record.file_path },
      error
    );
  }

  let blocks: ReturnType<typeof parsePdfBlocks>;
  try {
    blocks = parsePdfBlocks(bytes);
  } catch (error) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `Candidate PDF cannot be parsed: ${record.file_path}.`,
      { filePath: record.file_path },
      error
    );
  }
  const health = assessExtractionHealth(blocks);
  if (!health.ok) {
    const reason = health.reason;
    return {
      reason,
      message:
        reason === "text_too_short"
          ? `Candidate PDF has too little extractable text: ${record.file_path}.`
          : `Candidate PDF has character-spaced CJK extraction: ${record.file_path}.`
    };
  }
  return buildMineDraft(candidate, record, id, blocks);
}

/**
 * 检查批次目录是否已存在且非空。
 *
 * @param config 当前工作区配置。
 * @param batch 待创建批次。
 * @returns 冲突说明；可安全创建时为 undefined。
 */
async function findBatchCollision(
  config: WorkspaceConfig,
  batch: string
): Promise<string | undefined> {
  const batchDir = join(config.draftRoot, batch);
  assertContainedPath(config.workspaceRoot, batchDir);
  try {
    const entries = await readdir(batchDir);
    return entries.length > 0
      ? `Draft batch ${batch} already exists and cannot be overwritten.`
      : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * 为无候选输入构造占位候选，供批次级冲突诊断使用。
 *
 * @returns 空候选。
 */
function emptyCandidate(): MineCandidate {
  return {
    ticker: "",
    report_type: "",
    period: "",
    type: "numeric_fact"
  };
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
 * 将 evidence I/O 异常转换为候选跳过项。
 *
 * @param error 捕获异常。
 * @param candidate 当前候选。
 * @param id 候选 ID。
 * @returns 稳定的跳过诊断。
 */
function mapEvidenceError(
  error: unknown,
  candidate: MineCandidate,
  id: string
): MineSkip {
  if (
    error instanceof GoldenStudioError &&
    (error.code === "evidence_not_found" || error.code === "evidence_parse_failed")
  ) {
    return {
      candidate,
      id,
      reason: error.code,
      message: error.message
    };
  }
  if (error instanceof WorkspaceError) throw error;
  throw error;
}
