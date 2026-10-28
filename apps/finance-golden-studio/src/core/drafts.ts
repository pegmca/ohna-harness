import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { GoldenStudioError } from "./errors.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type {
  BatchSummary,
  DraftSummary,
  GoldenDraft,
  SaveDraftResult
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import {
  assertContainedPath,
  validateBatchName,
  validateDraftId
} from "./workspace.js";

/**
 * 枚举 `_drafts/` 下的批次并汇总草稿状态。
 *
 * 目录不存在时返回空列表；非目录与损坏草稿文件不会阻断其他批次枚举。
 *
 * @param config 当前工作区配置。
 * @returns 按名称排序的批次摘要。
 */
export async function listBatches(config: WorkspaceConfig): Promise<BatchSummary[]> {
  assertContainedPath(config.workspaceRoot, config.draftRoot);
  const entries = await readDirectory(config.draftRoot);
  const batches: BatchSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    validateBatchName(entry.name);
    const drafts = await listDrafts(config, entry.name);
    const approvedCount = drafts.filter((draft) => draft.approved).length;
    const corruptCount = drafts.filter((draft) => draft.corrupt).length;
    batches.push({
      name: entry.name,
      draftCount: drafts.length,
      approvedCount,
      pendingCount: drafts.length - approvedCount - corruptCount,
      corruptCount
    });
  }

  return batches.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 枚举单个批次中的草稿摘要。
 *
 * 批次目录不存在时返回空列表；无法解析的 JSONL 以 corrupt 摘要保留，
 * 让 UI 能报告问题而不删除或隐藏人工文件。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @returns 按 ID 排序的草稿摘要。
 */
export async function listDrafts(
  config: WorkspaceConfig,
  batch: string
): Promise<DraftSummary[]> {
  validateBatchName(batch);
  const batchDir = join(config.draftRoot, batch);
  assertContainedPath(config.workspaceRoot, batchDir);
  const entries = await readDirectory(batchDir);
  const summaries: DraftSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("_")) {
      continue;
    }
    const id = entry.name.slice(0, -".jsonl".length);
    validateDraftId(id);
    try {
      const draft = await readDraft(config, batch, id);
      summaries.push({
        id,
        query: draft.query,
        type: draft.type,
        approved: draft._draft.approved === true,
        isNegative: draft.is_negative,
        health:
          typeof draft._draft.extraction_health === "string"
            ? draft._draft.extraction_health
            : undefined,
        corrupt: false
      });
    } catch (error) {
      if (!(error instanceof GoldenStudioError) || error.code !== "draft_corrupt") {
        throw error;
      }
      summaries.push({
        id,
        query: "",
        type: "",
        approved: false,
        isNegative: false,
        corrupt: true,
        errorCode: error.code
      });
    }
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * 读取并校验单个 JSONL 草稿。
 *
 * 文件必须恰好包含一个 JSON 对象，对象 ID 必须与路径 ID 一致。
 * 解析失败时只报告结构化错误，绝不删除或改写损坏文件。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @param id 草稿 ID。
 * @returns 完整草稿对象。
 * @throws {GoldenStudioError} 文件不存在或内容损坏时抛出。
 */
export async function readDraft(
  config: WorkspaceConfig,
  batch: string,
  id: string
): Promise<GoldenDraft> {
  const filePath = draftFilePath(config, batch, id);

  try {
    await stat(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new GoldenStudioError(
        "draft_not_found",
        `Draft not found: ${batch}/${id}.`,
        { batch, id, filePath },
        error
      );
    }
    throw error;
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new GoldenStudioError(
      "draft_corrupt",
      `Draft cannot be read: ${batch}/${id}.`,
      { batch, id, filePath },
      error
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch (error) {
    throw corruptDraftError(batch, id, filePath, "Invalid JSON", error);
  }

  if (!isRecord(parsed)) {
    throw corruptDraftError(batch, id, filePath, "Draft must be a JSON object");
  }
  if (parsed.id !== id) {
    throw corruptDraftError(
      batch,
      id,
      filePath,
      `Draft id must match its filename (received ${String(parsed.id)})`
    );
  }
  if (!isRecord(parsed._draft)) {
    throw corruptDraftError(batch, id, filePath, "Draft must contain _draft state");
  }

  return parsed as unknown as GoldenDraft;
}

/**
 * 原子保存草稿，并写入批次、保存时间和文件路径等本地元信息。
 *
 * `savedAt` 由服务端刷新；其余 `_draft` 字段（审核、校验快照、候选健康度）
 * 会原样保留。文件内容始终是单行 JSON 加末尾换行。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @param id 草稿 ID。
 * @param draft 待保存的完整草稿。
 * @returns 规范化后的草稿与目标路径。
 * @throws {WorkspaceError} 批次、ID 或目标路径越界时抛出。
 * @throws {GoldenStudioError} 草稿 ID 不一致或原子写入失败时抛出。
 */
export async function saveDraft(
  config: WorkspaceConfig,
  batch: string,
  id: string,
  draft: GoldenDraft
): Promise<SaveDraftResult> {
  const filePath = draftFilePath(config, batch, id);
  if (draft.id !== id) {
    throw new GoldenStudioError(
      "draft_corrupt",
      `Draft id ${draft.id} does not match requested id ${id}.`,
      { batch, id, filePath }
    );
  }

  const normalized: GoldenDraft = {
    ...draft,
    _draft: {
      ...draft._draft,
      batch,
      savedAt: new Date().toISOString(),
      filePath
    }
  };
  await mkdir(join(config.draftRoot, batch), { recursive: true });
  assertContainedPath(config.workspaceRoot, filePath);
  await writeFileAtomic(filePath, `${JSON.stringify(normalized)}\n`);
  return { draft: normalized, filePath };
}

/**
 * 校验批次和 ID 后派生草稿文件路径。
 *
 * @param config 当前工作区配置。
 * @param batch 批次名。
 * @param id 草稿 ID。
 * @returns 位于 draftRoot 内的草稿路径。
 */
function draftFilePath(config: WorkspaceConfig, batch: string, id: string): string {
  validateBatchName(batch);
  validateDraftId(id);
  const filePath = join(config.draftRoot, batch, `${id}.jsonl`);
  assertContainedPath(config.workspaceRoot, filePath);
  return filePath;
}

/**
 * 读取目录条目，缺失目录归一为空列表。
 *
 * @param path 目录路径。
 * @returns 目录条目；不存在时为空。
 */
async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/**
 * 构造损坏草稿的结构化错误。
 *
 * @param batch 批次名。
 * @param id 草稿 ID。
 * @param filePath 草稿文件路径。
 * @param reason 具体损坏原因。
 * @param cause 原始解析异常。
 * @returns 带 draft_corrupt 错误码的异常。
 */
function corruptDraftError(
  batch: string,
  id: string,
  filePath: string,
  reason: string,
  cause?: unknown
): GoldenStudioError {
  return new GoldenStudioError(
    "draft_corrupt",
    `Invalid JSON draft ${batch}/${id}: ${reason}.`,
    { batch, id, filePath, reason },
    cause
  );
}

/**
 * 判断文件系统异常是否表示目标缺失。
 *
 * @param error 捕获的异常。
 * @returns error.code 为 ENOENT 时为 true。
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
 * 判断值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组且非 null 的对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
