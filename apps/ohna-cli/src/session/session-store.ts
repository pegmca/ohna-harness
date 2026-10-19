/**
 * 会话持久化：把多轮 history 落成可 `cat` 的 JSONL 文件。
 *
 * 为什么用 JSONL 而不是数据库：本地单用户 Agent 的会话是「线性消息 + 一条元数据」，
 * JSONL 与 RunEvent / memory 的 append-only 心智同构，零基础设施即可跨进程恢复；
 * SQLite 仅在会话量级或全文检索成为瓶颈时再引入（v1.3 D5）。
 *
 * 文件格式（每行一个 JSON 对象）：
 *   第 1 行：{ type: "session", id, title, createdAt, updatedAt, workspaceRoot, messageCount, usage? }
 *   之后每行：{ type: "message", message: AgentMessage }
 *
 * 写入采用「临时文件 + rename」的原子替换：进程在写一半时被杀，磁盘上仍是上一份完整会话，
 * 不会出现半行 JSON 导致 load 直接失败（load 仍对损坏行做跳过兜底）。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@aiagent/agent";

/** 会话累计用量（供 --max-cost 与 /cost 跨进程恢复）。 */
export interface SessionUsageTotals {
  /** 累计输入 token。 */
  input: number;
  /** 累计输出 token。 */
  output: number;
  /** 累计 token 总数。 */
  total: number;
  /** 累计成本（美元）。 */
  cost: number;
  /** 累计推理 token（provider 上报；是 output 子集）。旧文件可能没有该字段。 */
  reasoning?: number;
}

/** 会话元数据（JSONL 首行）。 */
export interface SessionMeta {
  /** 会话 id，同时是文件名；只允许 [A-Za-z0-9_-]。 */
  id: string;
  /** 会话标题；缺省取首条 user 文本前 40 字符。 */
  title: string;
  /** 创建时间（Unix 毫秒）。 */
  createdAt: number;
  /** 最后写入时间（Unix 毫秒）。 */
  updatedAt: number;
  /** 创建会话时的工作区根目录。 */
  workspaceRoot: string;
  /** 消息条数（含 CompactionMessage）。 */
  messageCount: number;
  /** 累计用量（旧文件可能没有该字段）。 */
  usage?: SessionUsageTotals;
}

/** load 的返回值：元数据 + 线性消息。 */
export interface SessionRecord {
  meta: SessionMeta;
  messages: AgentMessage[];
}

/** create 的输入。 */
export interface CreateSessionInput {
  /** 显式指定 id（缺省随机 UUID）；用于测试或导入。 */
  id?: string;
  /** 会话标题；缺省从 messages 推断。 */
  title?: string;
  /** 工作区根目录；缺省为当前进程 cwd。 */
  workspaceRoot?: string;
  /** 初始消息（通常为空）。 */
  messages?: AgentMessage[];
  /** 初始累计用量（通常为空）。 */
  usage?: SessionUsageTotals;
}

/** save 时可覆盖的元数据；未提供的字段沿用磁盘上的旧值。 */
export interface SaveSessionOptions {
  /** 会话标题（首次由 harness 从首条用户输入推导后固定，避免压缩后丢失）。 */
  title?: string;
  /** 工作区根目录。 */
  workspaceRoot?: string;
  /** 会话累计用量快照。 */
  usage?: SessionUsageTotals;
}

/** JSONL 首行形状。 */
interface SessionHeaderLine extends SessionMeta {
  type: "session";
}

/** JSONL 消息行形状。 */
interface SessionMessageLine {
  type: "message";
  message: AgentMessage;
}

/** 会话存储接口（便于测试注入临时目录；Phase 2 的 packages/serve 会按同一语义实现自己的 store）。 */
export interface SessionStore {
  /** 会话文件所在目录。 */
  readonly dir: string;
  /** 新建会话并立即落盘。 */
  create(input?: CreateSessionInput): Promise<SessionMeta>;
  /** 覆盖式保存（原子替换）；返回最终元数据。 */
  save(id: string, messages: AgentMessage[], options?: SaveSessionOptions): Promise<SessionMeta>;
  /** 读取会话；文件不存在返回 null。 */
  load(id: string): Promise<SessionRecord | null>;
  /** 列出全部会话，按 updatedAt 倒序。 */
  list(): Promise<SessionMeta[]>;
}

/** 会话 id 的路径安全白名单：禁止 `../`、`/`、`.` 等可逃逸文件名的字符。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 标题最大长度（字符）。 */
const TITLE_MAX_LENGTH = 40;

/** SessionStore 构造选项。 */
export interface SessionStoreOptions {
  /** 会话目录；缺省 `~/.ohna/sessions`。测试必须注入临时目录，避免写真实 home。 */
  dir?: string;
}

/**
 * 校验会话 id：不符合白名单直接抛错，防止 `load("../../x")` 读写任意文件。
 *
 * @param id 待校验的会话 id。
 */
function assertValidId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`非法会话 id：${id}（仅允许字母、数字、下划线、连字符）`);
  }
}

/**
 * 从消息序列推断会话标题：取首条 user 文本，压缩空白后截前 40 字符。
 *
 * @param messages 消息序列。
 * @returns 标题；没有可用 user 文本时返回 undefined。
 */
export function deriveSessionTitle(messages: AgentMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join(" ");
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) return normalized.slice(0, TITLE_MAX_LENGTH);
  }
  return undefined;
}

/**
 * 判断内容字段是否为 user/assistant 可接受的最小形状：字符串或内容块数组。
 *
 * @param content 待检查的 content 字段。
 * @returns 合法返回 true。
 */
function isContentValue(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

/**
 * 按 role 校验消息的最小形状，避免只有 role 的坏行进入 history 后让 provider 400。
 *
 * - user / assistant：必须有 content（string 或数组）；
 * - toolResult：必须有 toolCallId 与数组 content；
 * - compaction：必须有字符串 summary。
 *
 * @param value 解析后的 JSON 值。
 * @returns 是否为可用消息行。
 */
function isMessageLine(value: unknown): value is SessionMessageLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { type?: unknown; message?: unknown };
  if (record.type !== "message") return false;
  const message = record.message as
    | { role?: unknown; content?: unknown; toolCallId?: unknown; summary?: unknown }
    | null;
  if (typeof message !== "object" || message === null || typeof message.role !== "string") return false;

  switch (message.role) {
    case "user":
    case "assistant":
      return isContentValue(message.content);
    case "toolResult":
      return typeof message.toolCallId === "string" && Array.isArray(message.content);
    case "compaction":
      return typeof message.summary === "string";
    default:
      return false;
  }
}

/**
 * 校验会话累计用量：四个字段必须是有限且非负的数字。
 *
 * 为什么整体丢弃而不是逐字段兜底：usage 会进入 `UsageTracker.restore` 与 `--max-cost` 比较，
 * 任一字段为 NaN / Infinity / 负数都会让成本判断失效（NaN 比较恒为 false，预算永远不触发）。
 * 宁可当旧文件没有 usage（从 0 重新累计），也不把脏数据带进预算系统。
 *
 * @param value JSONL 头部解析出的 usage 字段。
 * @returns 合法时返回 usage，否则 undefined。
 */
function parseUsage(value: unknown): SessionUsageTotals | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["input", "output", "total", "cost"] as const;
  for (const key of keys) {
    const field = record[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return undefined;
  }
  // reasoning 是可选字段（旧文件没有）：合法时才保留，否则省略（restore 按 0 兜底）。
  const reasoning =
    typeof record.reasoning === "number" && Number.isFinite(record.reasoning) && record.reasoning >= 0
      ? record.reasoning
      : undefined;
  return {
    input: record.input as number,
    output: record.output as number,
    total: record.total as number,
    cost: record.cost as number,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/**
 * 判断一行是否为会话头。
 *
 * @param value 解析后的 JSON 值。
 * @returns 是否为 session 行。
 */
function isHeaderLine(value: unknown): value is SessionHeaderLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string";
}

/**
 * 解析 JSONL 文本：损坏行（非法 JSON / 结构不符）跳过，保证单个坏行不毁掉整个会话。
 *
 * @param id 会话 id（用于无头部时合成元数据）。
 * @param raw 文件全文。
 * @returns 会话记录。
 */
function parseSessionFile(id: string, raw: string): SessionRecord {
  let header: SessionHeaderLine | undefined;
  const messages: AgentMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!header && isHeaderLine(parsed)) {
      header = parsed;
      continue;
    }
    if (isMessageLine(parsed)) {
      messages.push(parsed.message);
    }
  }

  // 头部损坏但消息可用时仍可恢复：用消息内容重建最小元数据（时间戳未知记 0）。
  // 头部字段可能来自旧版本或被手工编辑：缺字段/类型错误一律用安全默认值，只有 id 必须存在
  // （id 还是文件定位键，缺失时整行不视为 header，走重建分支）。
  const meta: SessionMeta = header
    ? {
        // 以文件名为准：即使头部 id 被手工改坏，也不会让 list/load 指向另一个文件。
        id,
        title:
          typeof header.title === "string" && header.title.trim()
            ? header.title
            : (deriveSessionTitle(messages) ?? "新会话"),
        createdAt:
          typeof header.createdAt === "number" && Number.isFinite(header.createdAt) ? header.createdAt : 0,
        updatedAt:
          typeof header.updatedAt === "number" && Number.isFinite(header.updatedAt) ? header.updatedAt : 0,
        workspaceRoot: typeof header.workspaceRoot === "string" ? header.workspaceRoot : "",
        messageCount: messages.length,
        usage: parseUsage(header.usage),
      }
    : {
        id,
        title: deriveSessionTitle(messages) ?? "新会话",
        createdAt: 0,
        updatedAt: 0,
        workspaceRoot: "",
        messageCount: messages.length,
      };

  return { meta, messages };
}

/**
 * 读取单个会话文件；不存在返回 null。
 *
 * @param filePath 会话文件路径。
 * @param id 会话 id。
 * @returns 会话记录或 null。
 */
async function readSessionFile(filePath: string, id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseSessionFile(id, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 创建基于文件系统的会话存储。
 *
 * @param options 可选的会话目录（测试注入临时目录）。
 * @returns SessionStore 实例。
 */
export function createSessionStore(options?: SessionStoreOptions): SessionStore {
  const dir = options?.dir ?? path.join(os.homedir(), ".ohna", "sessions");

  /** 计算会话文件路径（调用前保证 id 已校验）。 */
  const filePathFor = (id: string): string => path.join(dir, `${id}.jsonl`);

  /**
   * 原子写入：先写同目录临时文件，再 rename 覆盖目标。
   *
   * @param filePath 目标文件。
   * @param meta 会话元数据。
   * @param messages 消息序列。
   */
  const writeSession = async (filePath: string, meta: SessionMeta, messages: AgentMessage[]): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    const header: SessionHeaderLine = { type: "session", ...meta };
    const lines = [JSON.stringify(header)];
    for (const message of messages) {
      const line: SessionMessageLine = { type: "message", message };
      lines.push(JSON.stringify(line));
    }
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tempPath, lines.join("\n") + "\n", "utf8");
    await fs.rename(tempPath, filePath);
  };

  return {
    dir,

    async create(input?: CreateSessionInput): Promise<SessionMeta> {
      const id = input?.id ?? randomUUID();
      assertValidId(id);
      const now = Date.now();
      const messages = input?.messages ?? [];
      const meta: SessionMeta = {
        id,
        title: input?.title ?? deriveSessionTitle(messages) ?? "新会话",
        createdAt: now,
        updatedAt: now,
        workspaceRoot: input?.workspaceRoot ?? process.cwd(),
        messageCount: messages.length,
        ...(input?.usage ? { usage: input.usage } : {}),
      };
      await writeSession(filePathFor(id), meta, messages);
      return meta;
    },

    async save(id: string, messages: AgentMessage[], saveOptions?: SaveSessionOptions): Promise<SessionMeta> {
      assertValidId(id);
      const filePath = filePathFor(id);
      const existing = await readSessionFile(filePath, id);
      const now = Date.now();
      const usage = saveOptions?.usage ?? existing?.meta.usage;
      const meta: SessionMeta = {
        id,
        title:
          saveOptions?.title ??
          existing?.meta.title ??
          deriveSessionTitle(messages) ??
          "新会话",
        createdAt: existing?.meta.createdAt ?? now,
        updatedAt: now,
        workspaceRoot: saveOptions?.workspaceRoot ?? existing?.meta.workspaceRoot ?? process.cwd(),
        messageCount: messages.length,
        ...(usage ? { usage } : {}),
      };
      await writeSession(filePath, meta, messages);
      return meta;
    },

    async load(id: string): Promise<SessionRecord | null> {
      assertValidId(id);
      return readSessionFile(filePathFor(id), id);
    },

    async list(): Promise<SessionMeta[]> {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const metas: SessionMeta[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const id = entry.slice(0, -".jsonl".length);
        if (!SESSION_ID_PATTERN.test(id)) continue;
        const record = await readSessionFile(path.join(dir, entry), id);
        if (record) metas.push(record.meta);
      }
      return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}
