/**
 * 本地会话元数据存储：`<dataDir>/sessions/index.jsonl`。
 *
 * 为什么用「追加写索引」而不是每会话一个元数据文件：本地单用户会话列表是唯一读路径，
 * 追加 + 读时取每个 id 的最后一行，天然支持 touch/改名/归档而无需原地改写；
 * 代价是索引会随操作增长，单机规模下可接受（与 D5「JSONL 优先」一致）。
 */
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { appendJsonLine, ensureDir, isValidStoreId, nowIso, readJsonlLines } from "./jsonl.js";

/** 会话状态；归档后默认不出现在列表页。 */
export type LocalSessionStatus = "active" | "archived";

/** 一条会话元数据（index.jsonl 的一行）。 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  status: LocalSessionStatus;
  /** 归档时间；仅 status=archived 时存在。 */
  archivedAt?: string;
}

/** create 的输入。 */
export interface CreateSessionInput {
  /** 显式 id（缺省随机 UUID）；自动建会话时由调用方传入。 */
  id?: string;
  title?: string;
  workspaceRoot: string;
}

/** update 的输入。 */
export interface UpdateSessionInput {
  title?: string;
  status?: LocalSessionStatus;
}

/** JSONL 行形状。 */
interface SessionLine extends SessionMeta {
  type: "session";
}

/** 标题最大长度（字符），与 CLI 的派生规则保持一致。 */
const TITLE_MAX_LENGTH = 40;

/**
 * 从一段文本派生会话标题：压缩空白后截断。
 *
 * @param text 用户输入或标题。
 * @returns 非空标题。
 */
export function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, TITLE_MAX_LENGTH) : "新会话";
}

/**
 * 把任意解析值收窄为 SessionLine；缺字段的旧行/坏行跳过。
 *
 * @param value JSONL 行值。
 * @returns 合法行或 null。
 */
function toSessionLine(value: unknown): SessionLine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "session") return null;
  if (typeof record.id !== "string" || !isValidStoreId(record.id)) return null;
  const status = record.status === "archived" ? "archived" : "active";
  return {
    type: "session",
    id: record.id,
    title: typeof record.title === "string" && record.title.trim() ? record.title : "新会话",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
    workspaceRoot: typeof record.workspaceRoot === "string" ? record.workspaceRoot : "",
    status,
    ...(status === "archived" && typeof record.archivedAt === "string" ? { archivedAt: record.archivedAt } : {})
  };
}

/**
 * 本地会话元数据存储。
 *
 * 所有写操作串行化到同一个索引文件；读操作直接读全量后取「每个 id 的最后一行」。
 */
export class LocalSessionStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param dir 会话数据目录（通常是 `<dataDir>/sessions`）。
   */
  constructor(private readonly dir: string) {
    this.filePath = path.join(dir, "index.jsonl");
  }

  /**
   * 新建会话；同 id 已存在时直接返回已有元数据（自动建会话的幂等兜底）。
   *
   * @param input 标题、工作区与可选 id。
   * @returns 会话元数据。
   */
  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const id = input.id ?? randomUUID();
    if (!isValidStoreId(id)) throw new Error(`非法会话 id：${id}`);
    const existing = await this.get(id);
    if (existing) return existing;

    const now = nowIso();
    const meta: SessionMeta = {
      id,
      title: deriveTitle(input.title ?? "新会话"),
      createdAt: now,
      updatedAt: now,
      workspaceRoot: input.workspaceRoot,
      status: "active"
    };
    await this.append(meta);
    return meta;
  }

  /**
   * 列出会话（同一 id 取最后一行），按 updatedAt 倒序。
   *
   * @param options.includeArchived 是否包含归档会话，默认 false。
   * @returns 会话元数据列表。
   */
  async list(options?: { includeArchived?: boolean }): Promise<SessionMeta[]> {
    const latest = await this.readLatest();
    return [...latest.values()]
      .filter((meta) => options?.includeArchived || meta.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * 读取单个会话；不存在或 id 非法返回 null。
   *
   * @param id 会话 id。
   * @returns 会话元数据或 null。
   */
  async get(id: string): Promise<SessionMeta | null> {
    if (!isValidStoreId(id)) return null;
    const latest = await this.readLatest();
    return latest.get(id) ?? null;
  }

  /**
   * 刷新 lastActive 时间。
   *
   * @param id 会话 id。
   */
  async touch(id: string): Promise<void> {
    await this.update(id, {});
  }

  /**
   * 修改标题或归档状态；未提供字段沿用旧值。
   *
   * @param id 会话 id。
   * @param patch 标题 / 状态。
   * @returns 更新后的元数据；会话不存在返回 null。
   */
  async update(id: string, patch: UpdateSessionInput): Promise<SessionMeta | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const now = nowIso();
    const status = patch.status ?? existing.status;
    const meta: SessionMeta = {
      ...existing,
      title: patch.title !== undefined ? deriveTitle(patch.title) : existing.title,
      status,
      updatedAt: now,
      archivedAt: status === "archived" ? (existing.archivedAt ?? now) : undefined
    };
    await this.append(meta);
    return meta;
  }

  /**
   * 等待所有排队中的索引写入完成（进程关闭时调用）。
   */
  async close(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  /**
   * 追加一行索引并串行化写入。
   *
   * @param meta 会话元数据。
   */
  private append(meta: SessionMeta): Promise<void> {
    const line: SessionLine = { type: "session", ...meta };
    const task = this.writeChain.then(async () => {
      await ensureDir(this.dir);
      await appendJsonLine(this.filePath, line);
    });
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  /**
   * 读取索引并折叠为「id → 最后一行」。
   *
   * @returns 最新元数据映射。
   */
  private async readLatest(): Promise<Map<string, SessionMeta>> {
    const rows = await readJsonlLines(this.filePath);
    const latest = new Map<string, SessionMeta>();
    for (const row of rows) {
      const line = toSessionLine(row);
      if (line) latest.set(line.id, line);
    }
    return latest;
  }
}
