/**
 * 本地线性消息存储：`<dataDir>/conversations/<conversationId>.jsonl`。
 *
 * 文件格式：
 *   首行 `{ type:"conversation_meta", id, title, createdAt, updatedAt }`
 *   之后每行一条 `LinearMessageDto`（sequence 从 1 递增）
 *
 * 写入按 conversation 串行化，sequence 由存储分配（客户端不参与），
 * 保证「同一会话内消息严格线性」；损坏行在读取时跳过，单行坏数据不会毁掉整个会话。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CursorPageDto, LinearMessageDto } from "@aiagent/types";
import {
  appendJsonLine,
  ensureDir,
  isValidStoreId,
  jsonlPath,
  nowIso,
  readJsonlLines,
  serializedWrite
} from "./jsonl.js";

/** 会话文件首行元数据。 */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 追加消息的输入；messageId / sequence / conversationId / createdAt 由存储生成。 */
export interface AppendMessageInput {
  role: LinearMessageDto["role"];
  content: unknown;
  runId?: string;
  messageType?: LinearMessageDto["messageType"];
  usage?: unknown;
  modelId?: string;
  stopReason?: string;
}

/** 首行 JSONL 形状。 */
interface ConversationMetaLine extends ConversationMeta {
  type: "conversation_meta";
}

/** 列表分页参数。 */
export interface MessagePageQuery {
  /** 已见的最大 sequence；返回严格大于该值的消息。 */
  afterSequence?: number;
  limit?: number;
}

/**
 * 判断一行是否是合法的 LinearMessageDto（最小形状校验）。
 *
 * @param value 解析后的 JSON 值。
 * @returns 可进入读模型的 DTO 或 null。
 */
function toLinearMessage(value: unknown): LinearMessageDto | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "conversation_meta") return null;
  if (
    typeof record.messageId !== "string" ||
    typeof record.conversationId !== "string" ||
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 1 ||
    (record.role !== "user" && record.role !== "assistant" && record.role !== "toolResult")
  ) {
    return null;
  }
  return {
    messageId: record.messageId,
    conversationId: record.conversationId,
    role: record.role,
    content: record.content,
    messageType: record.messageType === "compaction" ? "compaction" : "normal",
    sequence: record.sequence,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {})
  };
}

/**
 * 判断首行是否是会话元数据。
 *
 * @param value 解析后的 JSON 值。
 * @returns 元数据行或 null。
 */
function toConversationMeta(value: unknown): ConversationMetaLine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "conversation_meta" || typeof record.id !== "string") return null;
  return {
    type: "conversation_meta",
    id: record.id,
    title: typeof record.title === "string" ? record.title : "新会话",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso()
  };
}

/** 本地线性消息存储。 */
export class LocalMessageStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sequenceCache = new Map<string, number>();
  private readonly headerCache = new Set<string>();

  /**
   * @param dir 会话消息目录（通常是 `<dataDir>/conversations`）。
   */
  constructor(private readonly dir: string) {}

  /**
   * 确保会话文件存在；已存在时返回首行元数据。
   *
   * @param conversationId 会话 id。
   * @param title 新会话标题。
   * @returns 会话元数据。
   */
  async ensureConversation(conversationId: string, title: string): Promise<ConversationMeta> {
    const filePath = jsonlPath(this.dir, conversationId);
    return serializedWrite(this.queues, conversationId, async () => {
      await ensureDir(this.dir);
      if (!this.headerCache.has(conversationId)) {
        const exists = await fileExists(filePath);
        if (!exists) {
          const now = nowIso();
          const line: ConversationMetaLine = {
            type: "conversation_meta",
            id: conversationId,
            title,
            createdAt: now,
            updatedAt: now
          };
          await appendJsonLine(filePath, line);
        }
        this.headerCache.add(conversationId);
      }
      const messages = await this.readMessages(filePath, conversationId);
      this.sequenceCache.set(
        conversationId,
        messages.items.reduce((max, item) => Math.max(max, item.sequence), 0)
      );
      return messages.meta ?? {
        id: conversationId,
        title,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
    });
  }

  /**
   * 追加一条消息并分配连续 sequence。
   *
   * @param conversationId 会话 id。
   * @param input 消息内容（不含 id/sequence）。
   * @returns 落盘后的线性消息 DTO。
   */
  async append(conversationId: string, input: AppendMessageInput): Promise<LinearMessageDto> {
    const filePath = jsonlPath(this.dir, conversationId);
    return serializedWrite(this.queues, conversationId, async () => {
      await ensureDir(this.dir);
      if (!this.headerCache.has(conversationId)) {
        if (!(await fileExists(filePath))) {
          const now = nowIso();
          await appendJsonLine(filePath, {
            type: "conversation_meta",
            id: conversationId,
            title: "新会话",
            createdAt: now,
            updatedAt: now
          } satisfies ConversationMetaLine);
        }
        this.headerCache.add(conversationId);
      }

      let sequence = this.sequenceCache.get(conversationId);
      if (sequence === undefined) {
        const existing = await this.readMessages(filePath, conversationId);
        sequence = existing.items.reduce((max, item) => Math.max(max, item.sequence), 0);
        this.sequenceCache.set(conversationId, sequence);
      }
      const next = sequence + 1;
      const message: LinearMessageDto = {
        messageId: randomUUID(),
        conversationId,
        role: input.role,
        content: input.content,
        messageType: input.messageType ?? "normal",
        sequence: next,
        createdAt: nowIso(),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.stopReason ? { stopReason: input.stopReason } : {})
      };
      await appendJsonLine(filePath, message);
      this.sequenceCache.set(conversationId, next);
      return message;
    });
  }

  /**
   * 读取会话全部消息，按 sequence 升序。
   *
   * @param conversationId 会话 id。
   * @returns 线性消息列表。
   */
  async list(conversationId: string): Promise<LinearMessageDto[]> {
    if (!isValidStoreId(conversationId)) return [];
    const filePath = jsonlPath(this.dir, conversationId);
    const result = await this.readMessages(filePath, conversationId);
    this.sequenceCache.set(conversationId, result.items.reduce((max, item) => Math.max(max, item.sequence), 0));
    return result.items;
  }

  /**
   * 游标分页：cursor 为「已见的最大 sequence」，返回严格更大的消息。
   *
   * @param conversationId 会话 id。
   * @param query afterSequence 与 limit（默认 50）。
   * @returns 消息游标页。
   */
  async listPage(
    conversationId: string,
    query: MessagePageQuery = {}
  ): Promise<CursorPageDto<LinearMessageDto>> {
    const limit = normalizeLimit(query.limit, 50);
    const afterSequence = normalizeCursor(query.afterSequence);
    const all = await this.list(conversationId);
    const remaining = all.filter((message) => message.sequence > afterSequence);
    const items = remaining.slice(0, limit);
    return {
      items,
      ...(remaining.length > items.length ? { nextCursor: String(items.at(-1)?.sequence ?? afterSequence) } : {})
    };
  }

  /**
   * 读取首行元数据；文件不存在返回 null。
   *
   * @param conversationId 会话 id。
   * @returns 会话元数据或 null。
   */
  async getMeta(conversationId: string): Promise<ConversationMeta | null> {
    if (!isValidStoreId(conversationId)) return null;
    const result = await this.readMessages(jsonlPath(this.dir, conversationId), conversationId);
    return result.meta;
  }

  /**
   * 等待所有排队写入完成。
   */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((task) => task.catch(() => undefined)));
  }

  /**
   * 读取并排序一个会话文件。
   *
   * @param filePath 文件路径。
   * @param conversationId 会话 id（用于补齐 DTO 字段）。
   * @returns 元数据与消息。
   */
  private async readMessages(
    filePath: string,
    conversationId: string
  ): Promise<{ meta: ConversationMeta | null; items: LinearMessageDto[] }> {
    const rows = await readJsonlLines(filePath);
    let meta: ConversationMeta | null = null;
    const items: LinearMessageDto[] = [];
    for (const row of rows) {
      const header = toConversationMeta(row);
      if (header) {
        meta = { id: conversationId, title: header.title, createdAt: header.createdAt, updatedAt: header.updatedAt };
        continue;
      }
      const message = toLinearMessage(row);
      if (message) items.push({ ...message, conversationId });
    }
    items.sort((left, right) => left.sequence - right.sequence);
    return { meta, items };
  }
}

/**
 * 判断文件是否存在。
 *
 * @param filePath 文件路径。
 * @returns 存在返回 true。
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 归一化 limit：正整数且上限 200，非法回退默认值。
 *
 * @param value 原始 limit。
 * @param fallback 默认值。
 * @returns 可用 limit。
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 200) : fallback;
}

/**
 * 归一化游标：非负整数，非法回退 0。
 *
 * @param value 原始游标。
 * @returns 非负整数。
 */
function normalizeCursor(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
