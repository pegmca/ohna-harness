/**
 * 本地 Run 事件存储：`<dataDir>/runs/<runId>.jsonl`。
 *
 * 文件格式：
 *   首行 `{ type:"run_meta", runId, requestId, conversationId, modelId, mode, source, userMessageId, createdAt }`
 *   之后每行一条 `RunStreamEventDtoV2`
 *
 * 取舍（03 §6.2）：`message_update` 是逐 delta 的瞬态事件，落盘会让 JSONL 无界膨胀，
 * 因此只在 SSE 实时帧中出现；`message_end` / `tool_execution_*` / `agent_end` / `run_status`
 * 等关键事件落盘，断线重连后由「已落盘事件 + 会话消息列表」恢复终态。
 */
import { promises as fs } from "node:fs";
import type {
  RunSnapshotDtoV2,
  RunStatusDtoV2,
  RunStreamEventDtoV2,
  RunEventTypeDto
} from "@aiagent/types";
import { redactSensitiveText } from "@aiagent/trace";
import {
  appendJsonLine,
  ensureDir,
  isValidStoreId,
  jsonlPath,
  readJsonlLines
} from "./jsonl.js";

/** run 元数据（文件首行）。 */
export interface RunMeta {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
  userMessageId: string;
  createdAt: string;
}

/** JSONL 首行形状。 */
interface RunMetaLine extends RunMeta {
  type: "run_meta";
}

/** 终态状态集合。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** 不落盘的瞬态事件类型。 */
const TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set(["message_update"]);

/**
 * 判断事件是否应落盘。
 *
 * @param type 事件类型。
 * @returns 关键事件返回 true。
 */
export function isPersistableRunEvent(type: string): boolean {
  return !TRANSIENT_EVENT_TYPES.has(type);
}

/**
 * 判断 run 状态是否终态。
 *
 * @param status 状态值。
 * @returns 终态返回 true。
 */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 递归脱敏 run payload：只对字符串做模式级（secret / PII）替换，保持对象与数组结构。
 *
 * 为什么不用 `redactSensitiveValue`：后者会按键名（`content` / `messages` / `prompt` 等）
 * 把整段文本替换成 `[redacted]`，并把长字符串截断到 500 字符。JSONL 是断线重连 replay
 * 的正文来源，键级替换与截断会让用户提问和长回答在重连后不可用。
 *
 * 取舍：JSONL 只做「模式级」脱敏（Bearer / sk- / 邮箱 / 手机号 / 身份证 / 银行卡），
 * 不做键级 PII 治理；完整正文以会话消息文件（`conversations/<id>.jsonl`）为准。
 *
 * @param value 事件 payload 的任意 JSON 值。
 * @returns 深拷贝后的脱敏值；数字 / 布尔 / null 原样保留。
 */
function sanitizeRunPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRunPayload(item));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeRunPayload(child);
    }
    return result;
  }
  return value;
}

/**
 * 把任意解析值收窄为 RunStreamEventDtoV2；坏行与瞬态事件返回 null。
 *
 * @param value JSONL 行值。
 * @returns 事件 DTO 或 null。
 */
function toRunEvent(value: unknown): RunStreamEventDtoV2 | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.eventId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.requestId !== "string" ||
    typeof record.conversationId !== "string" ||
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.type !== "string" ||
    !isPersistableRunEvent(record.type) ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  return record as unknown as RunStreamEventDtoV2;
}

/**
 * 把任意解析值收窄为 RunMetaLine。
 *
 * @param value JSONL 行值。
 * @returns 元数据行或 null。
 */
function toRunMeta(value: unknown): RunMetaLine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "run_meta" || typeof record.runId !== "string") return null;
  return {
    type: "run_meta",
    runId: record.runId,
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    conversationId: typeof record.conversationId === "string" ? record.conversationId : "",
    modelId: typeof record.modelId === "string" ? record.modelId : "",
    mode: record.mode === "report" ? "report" : "auto",
    source: record.source === "report_button" ? "report_button" : "composer",
    userMessageId: typeof record.userMessageId === "string" ? record.userMessageId : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString()
  };
}

/** 本地 Run 事件存储。 */
export class LocalRunStore {
  private readonly queues = new Map<string, Promise<void>>();
  /** 内存态终态缓存：正常路径由 run_status 事件持久化，这里只加速进程内查询。 */
  private readonly statusCache = new Map<string, RunStatusDtoV2>();

  /**
   * @param dir run 事件目录（通常是 `<dataDir>/runs`）。
   */
  constructor(private readonly dir: string) {}

  /**
   * 创建 run 文件（首行元数据）。同 runId 已存在时不重复写。
   *
   * @param meta run 元数据。
   */
  async create(meta: RunMeta): Promise<void> {
    const filePath = jsonlPath(this.dir, meta.runId);
    const line: RunMetaLine = { type: "run_meta", ...meta };
    await this.enqueue(meta.runId, async () => {
      await ensureDir(this.dir);
      if (await fileExists(filePath)) return;
      await appendJsonLine(filePath, line);
    });
  }

  /**
   * 追加一条事件；瞬态事件（message_update）与损坏事件静默跳过。
   *
   * 持久化副本只做**模式级**脱敏（不改键、不截断），保证 replay 能还原正文；
   * SSE 实时帧由 run-manager 直接广播原始 payload，不经此函数。
   *
   * @param runId run id。
   * @param event canonical run event。
   */
  async appendEvent(runId: string, event: RunStreamEventDtoV2): Promise<void> {
    if (!isPersistableRunEvent(event.type)) return;
    const filePath = jsonlPath(this.dir, runId);
    // 仅脱敏 payload：eventId/runId/sequence 等定位字段必须保持原样。
    const safeEvent: RunStreamEventDtoV2 = {
      ...event,
      payload: sanitizeRunPayload(event.payload)
    };
    await this.enqueue(runId, async () => {
      await ensureDir(this.dir);
      await appendJsonLine(filePath, safeEvent);
    });
  }

  /**
   * 读取 run 的全部已落盘事件（按 sequence 升序）。
   *
   * @param runId run id。
   * @returns 事件列表；run 不存在返回空数组。
   */
  async listEvents(runId: string): Promise<RunStreamEventDtoV2[]> {
    if (!isValidStoreId(runId)) return [];
    const { events } = await this.readRun(runId);
    return events;
  }

  /**
   * 从 JSONL 重建 Run 快照。
   *
   * 进程重启后仍处于 running 的 run 视为 interrupted：单机没有后台 worker 会继续推进它。
   *
   * @param runId run id。
   * @returns 快照或 null（run 不存在）。
   */
  async getRun(runId: string): Promise<RunSnapshotDtoV2 | null> {
    if (!isValidStoreId(runId)) return null;
    const { meta, events } = await this.readRun(runId);
    if (!meta && events.length === 0) return null;

    const first = events[0];
    const resolvedMeta: RunMeta = meta ?? {
      runId,
      requestId: first?.requestId ?? "",
      conversationId: first?.conversationId ?? "",
      modelId: "",
      mode: "auto",
      source: "composer",
      userMessageId: "",
      createdAt: first?.createdAt ?? new Date().toISOString()
    };

    let status: RunStatusDtoV2 = this.statusCache.get(runId) ?? "interrupted";
    let error: RunSnapshotDtoV2["error"];
    let completedAt: string | undefined;
    let lastEventSequence = 0;

    for (const event of events) {
      lastEventSequence = Math.max(lastEventSequence, event.sequence);
      const payload = (event.payload ?? {}) as {
        status?: string;
        error?: { code?: string; message?: string; requestId?: string; details?: Record<string, unknown> };
      };
      if (event.type === "run_status" && payload.status && isTerminalRunStatus(payload.status)) {
        status = payload.status as RunStatusDtoV2;
        completedAt = event.createdAt;
        if (payload.error) {
          error = {
            code: payload.error.code ?? "agent_failed",
            message: payload.error.message ?? "Run 失败。",
            requestId: payload.error.requestId ?? event.requestId,
            details: payload.error.details
          };
        }
      }
      if (event.type === "run_error") {
        status = "failed";
        completedAt = event.createdAt;
        error = {
          code: payload.error?.code ?? "internal_error",
          message: payload.error?.message ?? "Run 失败。",
          requestId: payload.error?.requestId ?? event.requestId,
          details: payload.error?.details
        };
      }
    }

    const updatedAt = events.at(-1)?.createdAt ?? resolvedMeta.createdAt;
    return {
      runId,
      requestId: resolvedMeta.requestId,
      conversationId: resolvedMeta.conversationId,
      userMessageId: resolvedMeta.userMessageId,
      modelId: resolvedMeta.modelId,
      mode: resolvedMeta.mode,
      source: resolvedMeta.source,
      status,
      lastEventSequence,
      createdAt: resolvedMeta.createdAt,
      updatedAt,
      startedAt: resolvedMeta.createdAt,
      ...(completedAt ? { completedAt } : {}),
      ...(error ? { error } : {})
    };
  }

  /**
   * 记录终态。正常路径以 run_status 事件为事实源；这里只更新进程内缓存，
   * 避免为一次状态变更重写 append-only 文件。
   *
   * @param runId run id。
   * @param status 终态。
   */
  async markStatus(runId: string, status: RunStatusDtoV2): Promise<void> {
    this.statusCache.set(runId, status);
  }

  /**
   * 等待所有排队写入完成。
   */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((task) => task.catch(() => undefined)));
  }

  /**
   * 读取元数据与事件。
   *
   * @param runId run id。
   * @returns 元数据（可能缺失）与事件。
   */
  private async readRun(runId: string): Promise<{ meta: RunMeta | null; events: RunStreamEventDtoV2[] }> {
    const rows = await readJsonlLines(jsonlPath(this.dir, runId));
    let meta: RunMeta | null = null;
    const events: RunStreamEventDtoV2[] = [];
    for (const row of rows) {
      const metaLine = toRunMeta(row);
      if (metaLine) {
        meta = {
          runId,
          requestId: metaLine.requestId,
          conversationId: metaLine.conversationId,
          modelId: metaLine.modelId,
          mode: metaLine.mode,
          source: metaLine.source,
          userMessageId: metaLine.userMessageId,
          createdAt: metaLine.createdAt
        };
        continue;
      }
      const event = toRunEvent(row);
      if (event) events.push({ ...event, runId });
    }
    events.sort((left, right) => left.sequence - right.sequence);
    return { meta, events };
  }

  /**
   * 串行化单个 run 文件的写入。
   *
   * @param runId run id。
   * @param task 写入逻辑。
   */
  private async enqueue(runId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const current = previous.then(task);
    this.queues.set(runId, current.catch(() => undefined));
    await current;
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

/** 重新导出事件类型，便于 store 使用方避免深引 @aiagent/types。 */
export type { RunEventTypeDto };
