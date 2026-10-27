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
import * as path from "node:path";
import type {
  RunMetaDtoV2,
  RunModeDtoV2,
  RunSnapshotDtoV2,
  RunSourceDtoV2,
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
import { SCHEMA_VERSION, isCompatibleSchema, declaredSchemaVersion } from "./schema.js";

/** run 元数据（文件首行）。 */
export interface RunMeta {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  mode: RunModeDtoV2;
  source: RunSourceDtoV2;
  userMessageId: string;
  createdAt: string;
}

/** JSONL 首行形状。 */
interface RunMetaLine extends RunMeta {
  type: "run_meta";
  /** 数据格式版本号（Task 10 §8.3：读取侧据此隔离不兼容版本）。 */
  schema: number;
}

/**
 * `runs/index.jsonl` 的索引行：只放「会话 → run」的定位字段。
 *
 * 为什么需要索引：`runs/` 下每个 run 一个文件，按会话列 run 需要遍历整个目录；
 * 追加式索引让 `GET /api/conversations/:id/runs` 只读一个文件。状态是易变字段，
 * 不进索引——由 RunManager 传入 statusResolver 合并（内存态优先）。
 */
interface RunIndexLine extends Omit<RunMeta, "userMessageId"> {
  type: "run_index";
}

/** 索引文件名（不是 runId，用固定名字区分）。 */
const INDEX_FILE_NAME = "index.jsonl";

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
 * 收窄 run 模式，未知值回退 auto（历史文件没有 observe）。
 *
 * @param value 原始字段值。
 * @returns 合法的模式值。
 */
function toRunMode(value: unknown): RunModeDtoV2 {
  if (value === "report") return "report";
  if (value === "observe") return "observe";
  return "auto";
}

/**
 * 收窄 run 触发入口，未知值回退 composer。
 *
 * @param value 原始字段值。
 * @returns 合法的来源值。
 */
function toRunSource(value: unknown): RunSourceDtoV2 {
  if (value === "report_button") return "report_button";
  if (value === "cli") return "cli";
  return "composer";
}

/**
 * 把任意解析值收窄为 RunMetaLine。
 *
 * 若首行 meta 声明的 schema 版本与当前 `SCHEMA_VERSION` 不兼容，返回 null（该 run
 * 被隔离：不进入读模型，不加载事件），保持「不兼容的旧格式不静默降级」的硬约束。
 *
 * @param value JSONL 行值。
 * @returns 元数据行或 null（类型不对 / 版本不兼容）。
 */
function toRunMeta(value: unknown): RunMetaLine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "run_meta" || typeof record.runId !== "string") return null;
  // 首行必须声明兼容的 schema 版本；缺省视为不兼容（不加载）。无旧格式迁移逻辑。
  if (!isCompatibleSchema(declaredSchemaVersion(value))) return null;
  return {
    type: "run_meta",
    schema: SCHEMA_VERSION,
    runId: record.runId,
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    conversationId: typeof record.conversationId === "string" ? record.conversationId : "",
    modelId: typeof record.modelId === "string" ? record.modelId : "",
    mode: toRunMode(record.mode),
    source: toRunSource(record.source),
    userMessageId: typeof record.userMessageId === "string" ? record.userMessageId : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString()
  };
}

/**
 * 把任意解析值收窄为索引行（`runs/index.jsonl` 的一行）。
 *
 * @param value JSONL 行值。
 * @returns 索引行或 null。
 */
function toRunIndex(value: unknown): RunIndexLine | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "run_index" || typeof record.runId !== "string") return null;
  return {
    type: "run_index",
    runId: record.runId,
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    conversationId: typeof record.conversationId === "string" ? record.conversationId : "",
    modelId: typeof record.modelId === "string" ? record.modelId : "",
    mode: toRunMode(record.mode),
    source: toRunSource(record.source),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString()
  };
}

/**
 * 由 run_meta 构造索引行（create 与 legacy 回填共用，保证两条路径字段一致）。
 *
 * @param meta run 元数据。
 * @returns 索引行。
 */
function toIndexLine(meta: RunMeta): RunIndexLine {
  return {
    type: "run_index",
    runId: meta.runId,
    requestId: meta.requestId,
    conversationId: meta.conversationId,
    modelId: meta.modelId,
    mode: meta.mode,
    source: meta.source,
    createdAt: meta.createdAt
  };
}

/** 本地 Run 事件存储。 */
export class LocalRunStore {
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * 索引文件的**独立**串行队列。
   *
   * 为什么不复用 per-run 的 `queues`：索引是全局单文件，按 runId 分队列会让多个 run
   * 并发 append 同一文件，行序不可控。独立队列把所有索引写入串成一条链。
   */
  private indexTail: Promise<void> = Promise.resolve();
  /** 已进索引的 runId（懒加载；避免每次 create 都全文扫描索引）。 */
  private indexedRunIds: Set<string> | undefined;
  /** 索引懒加载的共享 Promise（并发 create 只读一次）。 */
  private indexLoad: Promise<Set<string>> | undefined;
  /** legacy 回填的共享 Promise（进程内只扫一次；并发 list 共享同一结果）。 */
  private backfill: Promise<void> | undefined;
  /** 内存态终态缓存：正常路径由 run_status 事件持久化，这里只加速进程内查询。 */
  private readonly statusCache = new Map<string, RunStatusDtoV2>();

  /**
   * @param dir run 事件目录（通常是 `<dataDir>/runs`）。
   */
  constructor(private readonly dir: string) {}

  /**
   * 创建 run 文件（首行元数据）并确保索引里有该 run。
   *
   * 同 runId 已存在时不重写 run 文件，但会补写缺失的索引行——旧数据目录（索引引入前）
   * 与「索引写失败但 run 文件成功」两种情况下，侧栏都不会漏 run。
   *
   * @param meta run 元数据。
   */
  async create(meta: RunMeta): Promise<void> {
    const filePath = jsonlPath(this.dir, meta.runId);
    // 首行写入数据格式版本，供读取侧做兼容性隔离（Task 10 §8.3）。
    const line: RunMetaLine = { type: "run_meta", schema: SCHEMA_VERSION, ...meta };
    await this.enqueue(meta.runId, async () => {
      await ensureDir(this.dir);
      if (!(await fileExists(filePath))) await appendJsonLine(filePath, line);
      await this.appendIndexIfMissing(meta);
    });
  }

  /**
   * 按会话列出 run 摘要（观测台 runs 侧栏）。
   *
   * 状态是易变字段、不进索引：优先用 `resolveStatus`（RunManager 传入内存态活跃
   * run 的快照状态），缺失时回读该 run 的事件文件推导，再退回 interrupted
   * （与 getRun 的「重启后仍在 running 视为 interrupted」语义一致）。
   *
   * @param conversationId 会话 id。
   * @param resolveStatus 内存态状态解析器（可选）。
   * @returns 按创建时间倒序的 run 摘要列表。
   */
  async listRunsByConversation(
    conversationId: string,
    resolveStatus: (runId: string) => RunStatusDtoV2 | undefined = () => undefined
  ): Promise<RunMetaDtoV2[]> {
    // 旧数据目录没有索引：先回填，否则侧栏会是空的（进程内只扫一次）。
    await this.ensureIndexBackfilled();
    const rows = await readJsonlLines(path.join(this.dir, INDEX_FILE_NAME));
    // 同 runId 重复写入时后者覆盖（append-only 索引天然允许重复行）。
    const byRunId = new Map<string, RunIndexLine>();
    for (const row of rows) {
      const index = toRunIndex(row);
      if (!index || index.conversationId !== conversationId) continue;
      byRunId.set(index.runId, index);
    }

    const metas: RunMetaDtoV2[] = [];
    for (const index of byRunId.values()) {
      const status =
        resolveStatus(index.runId) ?? (await this.getRun(index.runId))?.status ?? "interrupted";
      metas.push({
        runId: index.runId,
        requestId: index.requestId,
        conversationId: index.conversationId,
        modelId: index.modelId,
        mode: index.mode,
        source: index.source,
        status,
        createdAt: index.createdAt
      });
    }
    return metas.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
   * 等待所有排队写入（run 文件 + 索引）完成。
   */
  async close(): Promise<void> {
    await Promise.all([
      ...[...this.queues.values()].map((task) => task.catch(() => undefined)),
      this.indexTail.catch(() => undefined)
    ]);
  }

  /**
   * 索引回填（进程内一次）：按目录差集补齐缺失的 `run_index` 行。
   * 启动期对账显式调用此方法，让读模型在首次 list 之前即一致。
   *
   * 为什么按差集而不是「索引为空才回填」：create 路径会先写一行索引，
   * 之后 list 再看到「索引非空」就跳过扫描，legacy run 会永久漏掉（先 create 再 list 的常态顺序）。
   */
  private async ensureIndexBackfilled(): Promise<void> {
    if (!this.backfill) this.backfill = this.backfillIndex();
    await this.backfill;
  }

  /**
   * 公开对账入口：确保 run 索引已从磁盘完全差集回填（幂等、确定性）。
   *
   * 与私有 `ensureIndexBackfilled` 共享同一 `backfill` Promise（进程内只扫一次），
   * 因此首次 list / create 触发的回填不会被重复执行。`reconcileOnStart` 显式调用
   * 本方法，使「启动即一致」不依赖首次 list 的时机。
   *
   * @returns 回填完成的 Promise。
   */
  async reconcileIndex(): Promise<void> {
    await this.ensureIndexBackfilled();
  }

  /**
   * 回填实现：索引已有 runId 与目录内 run 文件做差集，只补缺失项。
   *
   * @returns 回填完成的 Promise。
   */
  private async backfillIndex(): Promise<void> {
    // TODO(W4 联调 / 计划 §8-7)：目前逐文件 readJsonlLines 只为取首行 run_meta，
    // 大数据目录下应改为「读取首行即停」的流式读；先与 N5 一起评估再优化。
    const indexPath = path.join(this.dir, INDEX_FILE_NAME);
    const existing = await readJsonlLines(indexPath);
    const existingIds = new Set<string>();
    for (const row of existing) {
      const index = toRunIndex(row);
      if (index) existingIds.add(index.runId);
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      // 目录还不存在：没有可回填的数据。
      this.indexedRunIds = existingIds;
      return;
    }

    const missing: RunMetaLine[] = [];
    for (const entry of entries) {
      if (entry === INDEX_FILE_NAME || !entry.endsWith(".jsonl")) continue;
      const rows = await readJsonlLines(path.join(this.dir, entry));
      const meta = toRunMeta(rows[0]);
      // 只补索引里没有的：已索引的 run 保持既有行（append-only，不重写历史）。
      if (meta && !existingIds.has(meta.runId)) missing.push(meta);
    }

    for (const meta of missing) existingIds.add(meta.runId);
    this.indexedRunIds = existingIds;
    if (missing.length === 0) return;

    await this.enqueueIndex(async () => {
      await ensureDir(this.dir);
      for (const meta of missing) await appendJsonLine(indexPath, toIndexLine(meta));
    });
  }

  /**
   * 索引里没有该 run 时补写一行（幂等）。
   *
   * 先触发回填：create 常常先于任何 list 发生，若不先补齐 legacy 项，
   * 这里写下的第一行索引会让后续 list 误判「索引已完整」。
   *
   * @param meta run 元数据。
   */
  private async appendIndexIfMissing(meta: RunMeta): Promise<void> {
    await this.ensureIndexBackfilled();
    const ids = await this.ensureIndexLoaded();
    if (ids.has(meta.runId)) return;
    await this.enqueueIndex(async () => {
      await ensureDir(this.dir);
      await appendJsonLine(path.join(this.dir, INDEX_FILE_NAME), toIndexLine(meta));
      ids.add(meta.runId);
    });
  }

  /**
   * 懒加载索引里的 runId 集合（并发调用共享同一次读取）。
   *
   * @returns 已索引的 runId 集合。
   */
  private async ensureIndexLoaded(): Promise<Set<string>> {
    if (this.indexedRunIds) return this.indexedRunIds;
    if (!this.indexLoad) {
      this.indexLoad = (async () => {
        const rows = await readJsonlLines(path.join(this.dir, INDEX_FILE_NAME));
        const ids = new Set<string>();
        for (const row of rows) {
          const index = toRunIndex(row);
          if (index) ids.add(index.runId);
        }
        return ids;
      })();
    }
    this.indexedRunIds = await this.indexLoad;
    return this.indexedRunIds;
  }

  /**
   * 串行化索引文件写入（全局单链，避免多 run 并发 append 交错）。
   *
   * @param task 写入逻辑。
   */
  private async enqueueIndex(task: () => Promise<void>): Promise<void> {
    const current = this.indexTail.then(task);
    this.indexTail = current.catch(() => undefined);
    await current;
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
