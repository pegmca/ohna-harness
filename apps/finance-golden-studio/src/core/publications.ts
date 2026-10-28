import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GoldenStudioError } from "./errors.js";
import { writeFileAtomic } from "./fs-atomic.js";
import type {
  GoldenCase,
  GoldenDraft,
  GoldenPublicationLedger,
  GoldenPublicationRecord
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/** 一次 promote 中由发布账本决定的新增与复用条目。 */
export interface PublicationPlan {
  ledger: GoldenPublicationLedger;
  promoted: Array<{ draftId: string; goldenId: string }>;
  reused: Array<{ draftId: string; goldenId: string }>;
}

/** 发布账本读写边界；生产默认全部使用真实原子文件。 */
export interface PublicationStore {
  write?: (path: string, content: string) => Promise<void>;
  golden?: (path: string, content: string) => Promise<void>;
}

/**
 * 规划草稿发布 ID，并返回供 golden 与账本双写使用的账本。
 *
 * 同一批次中内容哈希未变的草稿视为幂等重试；内容变化时分配新 ID。
 * 只接受已通过完整校验的草稿。
 *
 * @param records 现存作者集。
 * @param drafts 待发布草稿。
 * @param batch 批次名。
 * @param ledger 已恢复的发布账本。
 * @returns 作者集、新发布、复用条目与下一版账本。
 */
export function planPublications(
  records: readonly GoldenCase[],
  drafts: readonly GoldenDraft[],
  batch: string,
  ledger: GoldenPublicationLedger
): {
  records: GoldenCase[];
  promoted: Array<{ draftId: string; goldenId: string }>;
  reused: Array<{ draftId: string; goldenId: string }>;
  ledger: GoldenPublicationLedger;
} {
  const draftLedger = new Map(
    ledger.publications
      .filter((entry) => entry.batch === batch)
      .map((entry) => [entry.draftId, entry])
  );
  let maximum = maximumGoldenNumber(records);
  const nextRecords = [...records];
  const promoted: Array<{ draftId: string; goldenId: string }> = [];
  const reused: Array<{ draftId: string; goldenId: string }> = [];
  const publications = [...ledger.publications];

  for (const draft of drafts) {
    const { _draft: ignored, ...authoring } = draft;
    void ignored;
    const contentHash = stableHash(authoring);
    const previous = draftLedger.get(draft.id);
    if (
      previous?.contentHash === contentHash &&
      nextRecords.some((record) => record.id === previous.goldenId)
    ) {
      reused.push({ draftId: draft.id, goldenId: previous.goldenId });
      continue;
    }

    maximum += 1;
    const goldenId = `fin-${String(maximum).padStart(3, "0")}`;
    nextRecords.push({ ...authoring, id: goldenId });
    promoted.push({ draftId: draft.id, goldenId });
    publications.push({
      batch,
      draftId: draft.id,
      goldenId,
      contentHash,
      publishedAt: new Date().toISOString()
    });
  }

  return {
    records: nextRecords,
    promoted,
    reused,
    ledger: { version: 1, publications }
  };
}

/**
 * 读取正式发布账本；不存在时返回空账本。
 *
 * @param config 当前工作区配置。
 * @returns 已校验的发布账本。
 * @throws {GoldenStudioError} 账本损坏时抛出。
 */
export async function loadPublicationLedger(
  config: WorkspaceConfig
): Promise<GoldenPublicationLedger> {
  const path = publicationLedgerPath(config);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { version: 1, publications: [] };
    throw error;
  }
  return parseLedger(raw, path, "Publication ledger");
}

/**
 * 恢复 interrupted publish；pending 只作为 golden 与账本之间的短暂交换记录。
 *
 * @param config 当前工作区配置。
 * @param records golden 当前记录。
 * @param store 可注入账本写入器。
 * @returns 应继续使用的账本。
 */
export async function recoverPublications(
  config: WorkspaceConfig,
  records: readonly GoldenCase[],
  store: PublicationStore = {}
): Promise<GoldenPublicationLedger> {
  const ledgerPath = publicationLedgerPath(config);
  const pendingPath = pendingPublicationPath(config);
  let raw: string;
  try {
    raw = await readFile(pendingPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return loadPublicationLedger(config);
    throw error;
  }

  const pending = parseLedger(raw, pendingPath, "Pending publication record");
  const recovered: GoldenPublicationLedger = {
    version: 1,
    publications: pending.publications.filter((publication) =>
      records.some((record) => recordMatchesPublication(record, publication))
    )
  };

  if (recovered.publications.length > 0) {
    await (store.write ?? writeFileAtomic)(ledgerPath, serializeLedger(recovered));
  }
  await rm(pendingPath, { force: true });
  return recovered;
}

/**
 * 提交 golden 与账本；pending 在 golden 替换前落盘以支持崩溃恢复。
 *
 * @param config 当前工作区配置。
 * @param records 完整新作者集。
 * @param ledger 完整新账本。
 * @param store 可注入写入边界。
 */
export async function commitPublications(
  config: WorkspaceConfig,
  records: readonly GoldenCase[],
  ledger: GoldenPublicationLedger,
  store: PublicationStore = {}
): Promise<void> {
  const ledgerPath = publicationLedgerPath(config);
  const pendingPath = pendingPublicationPath(config);
  const write = store.write ?? writeFileAtomic;
  const writeGolden = store.golden ?? writeFileAtomic;

  await write(pendingPath, serializeLedger(ledger));
  await writeGolden(config.goldenPath, serializeGolden(records));
  await write(ledgerPath, serializeLedger(ledger));
  await rm(pendingPath, { force: true });
}

/**
 * 返回正式发布账本路径。
 *
 * @param config 当前工作区配置。
 * @returns 工作区内的发布账本路径。
 */
export function publicationLedgerPath(config: WorkspaceConfig): string {
  const path = join(dirname(config.goldenPath), "_publications.json");
  assertContainedPath(config.workspaceRoot, path);
  return path;
}

/**
 * 返回 pending 发布账本路径。
 *
 * @param config 当前工作区配置。
 * @returns 工作区内的 pending 账本路径。
 */
function pendingPublicationPath(config: WorkspaceConfig): string {
  const path = join(dirname(config.goldenPath), "_publications.pending.json");
  assertContainedPath(config.workspaceRoot, path);
  return path;
}

/**
 * 解析并校验发布账本。
 *
 * @param raw JSON 文本。
 * @param path 账本路径。
 * @param label 错误标签。
 * @returns 已校验账本。
 * @throws {GoldenStudioError} JSON 或形状非法时抛出。
 */
function parseLedger(
  raw: string,
  path: string,
  label: string
): GoldenPublicationLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new GoldenStudioError(
      "draft_corrupt",
      `${label} is invalid JSON.`,
      { path },
      error
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.publications) ||
    !value.publications.every(isPublicationRecord)
  ) {
    throw new GoldenStudioError(
      "draft_corrupt",
      `${label} has an invalid shape.`,
      { path }
    );
  }
  return value as unknown as GoldenPublicationLedger;
}

/**
 * 判断账本条目是否满足持久化形状。
 *
 * @param value 待验证值。
 * @returns 所有字段合法时为 true。
 */
function isPublicationRecord(value: unknown): value is GoldenPublicationRecord {
  return (
    isRecord(value) &&
    typeof value.batch === "string" &&
    typeof value.draftId === "string" &&
    typeof value.goldenId === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.publishedAt === "string"
  );
}

/**
 * 判断 golden 记录与 pending 发布是否具有相同草稿内容。
 *
 * @param record golden 记录。
 * @param publication 发布记录。
 * @returns ID、golden ID 与内容哈希均匹配时为 true。
 */
function recordMatchesPublication(
  record: GoldenCase,
  publication: GoldenPublicationRecord
): boolean {
  if (record.id !== publication.goldenId) return false;
  const { id: ignored, ...authoring } = record;
  void ignored;
  return (
    stableHash({ ...authoring, id: publication.draftId }) ===
    publication.contentHash
  );
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
 * 序列化作者集。
 *
 * @param records 作者集记录。
 * @returns JSONL 文本。
 */
function serializeGolden(records: readonly GoldenCase[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * 序列化发布账本。
 *
 * @param ledger 发布账本。
 * @returns 带末尾换行的 JSON。
 */
function serializeLedger(ledger: GoldenPublicationLedger): string {
  return `${JSON.stringify(ledger)}\n`;
}

/**
 * 对不含本地状态的作者内容生成稳定 SHA-256。
 *
 * @param value 可 JSON 序列化值。
 * @returns 十六进制 SHA-256。
 */
function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * 递归排序对象键，避免键顺序影响内容哈希。
 *
 * @param value 待稳定序列化值。
 * @returns 稳定 JSON 文本。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * 判断值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组且非 null 对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
