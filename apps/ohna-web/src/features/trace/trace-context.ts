/**
 * 上下文/Token 三面板的投影层（纯函数，可单测，docs/v2.0/04 §5.3）。
 *
 * 只从 run 事件流读取，**不重新估算**：
 * - `composition` 由采集层（`estimateComposition`）在 onPayload 现算并随 `llm_call` 落盘；
 * - `window` 由 serve 在构造 traced wrapper 时注入，是必填字段，与单次请求成败无关；
 * - `actual` 来自 provider 回报的 `usage`（缺失按 0，表示「本次没有拿到计量」）。
 *
 * 单次调用投影（`toContextPoint`）与整条序列投影（`buildContextPoints`）都对外导出，
 * 因为 Trace Trend 会在 live 时只对「新增那次调用」补点，而无需整条重算。
 */
import type {
  ContextEventPayloadDto,
  LlmCallRecordDto,
  LlmCallUsageDto,
  LlmCompositionDto,
  LlmWindowDto,
  RunStreamEventDtoV2
} from "@aiagent/types";
import { SUPERVISOR_AGENT_ID } from "./trace-labels";

/** 一次 LLM 请求的上下文快照（Trend 的一根堆叠条 / Composition 的数据源）。 */
export interface ContextPoint {
  /** run 内的调用序号（1 起，serve 分配）。 */
  callIndex: number;
  /**
   * 承载该记录的 `llm_call` 事件 sequence（Trend 的 ✂ 定位锚点）。
   *
   * 由投影层在**过滤之后**从事件信封写入，因此与 `points` 恒等同序；消费方不再另起一遍
   * `type === "llm_call"` 过滤，避免「坏记录被跳过 → 后续柱子整体错位一格」。
   */
  sequence: number;
  /** 发起方 agent；未打标归 supervisor 根节点（归属语义，不是降级）。 */
  agentId?: string;
  /** 五分类估算（onPayload 之后才存在：请求未到达 payload 时为空）。 */
  composition?: LlmCompositionDto;
  /** 窗口参数（必填，serve 注入）。 */
  window: LlmWindowDto;
  /** provider 实际回报的用量（缺失按 0）。 */
  actual: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 成本快照（缺失时为全 0）。 */
  cost: LlmCallUsageDto["cost"];
  /** 发起时刻（epoch 毫秒）。 */
  startedAt: number;
  /** 端到端耗时（毫秒）。 */
  durationMs?: number;
}

/** 上下文事件日志条目：payload 原样保留，另补上它在事件流里的序号锚点。 */
export interface ContextEventEntry {
  /** 事件 id。 */
  eventId: string;
  /** 事件 sequence：Trend 用它把 ✂ 标记钉到正确位置。 */
  sequence: number;
  /** 归属 agent（context_event 由 serve 在 run 编排层发射，恒归 supervisor）。 */
  agentId: string;
  /** 事件 payload。 */
  payload: ContextEventPayloadDto;
}

/** Trend 的一列：一次 `llm_call` 加上它在事件流里的序号锚点。 */
export interface ContextTrendColumn {
  /** 对应上下文点。 */
  point: ContextPoint;
  /** `llm_call` 事件的 sequence（✂ 定位锚点）。 */
  sequence: number;
}

/**
 * 上下文事件的净增量（tokensAfter - tokensBefore；compaction 为负）。
 */
export interface ContextEventDelta {
  /** 压缩前的会话 token。 */
  before: number;
  /** 压缩后的会话 token。 */
  after: number;
  /** 净增量：负值表示回收。 */
  delta: number;
}

/**
 * 把一条 `llm_call` 记录投影为上下文点。
 *
 * @param record 采集记录（payload 即 `LlmCallRecordDto`）。
 * @param sequence 承载该记录的事件 sequence（来自外层事件信封；缺省为 -1，
 *   仅供脱离事件流的单点构造使用，Trend 配对依赖它时请从 `buildContextPoints` 取）。
 * @returns 上下文点；`window` 直取 `record.window`，不做任何推导。
 */
export function toContextPoint(record: LlmCallRecordDto, sequence = -1): ContextPoint {
  const usage = record.response?.usage;
  return {
    sequence,
    callIndex: record.callIndex,
    agentId: record.agentId,
    composition: record.composition,
    window: record.window,
    actual: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0
    },
    cost: usage?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    startedAt: record.startedAt,
    durationMs: record.durationMs
  };
}

/**
 * 从事件流投影全部上下文点（按 `callIndex` 升序）。
 *
 * 为什么按 callIndex 而不是 sequence 排序：Team 场景下子代理与主线程各持一条 callIndex
 * 序列（serve 两条链各一条 wrapper），同号调用会并存；此时顺序按 sequence（事件先后）
 * 稳定保持，`callIndex` 只用于展示与定位，不承担唯一性。
 *
 * @param events 按 sequence 升序的 run 事件。
 * @returns 上下文点数组（保持事件顺序）。
 */
export function buildContextPoints(events: readonly RunStreamEventDtoV2[]): ContextPoint[] {
  const points: ContextPoint[] = [];
  for (const event of events) {
    if (event.type !== "llm_call") continue;
    const record = event.payload as LlmCallRecordDto | null;
    // 硬依赖是 `window`（占比/掩码都要它），不是 request 本身：文档 §3.2 + AGENTS.md 冻结的
    // 构建顺序是「wrapper 先构造（带 window）→ onPayload 之后才有 composition」，因此
    // window 与 request 由同一个 wrapper 产生、要么同时存在要么同时缺失。这里用「缺 request」
    // 作为「记录在到达 payload 之前就坏了」的代理判据：此类记录既没有窗口也没有构成，
    // 画不出任何比例尺，进上下文视图只会是一根零高柱。
    // 注意：`usage` / `cost` 的 0 兜底是另一回事——那是「调用发生了但没拿到计量」，
    // 与「记录不完整」不同口径，不能据此认为 request 可选。
    if (!record || !record.request || !record.window) continue;
    // sequence 与记录同源同批产出：配对键必须来自这里，而不是消费方另起一遍按 type 过滤
    // （过滤口径一旦与本次的 `continue` 判据不同，柱列与 ✂ 就会整体错位一格）。
    points.push(toContextPoint(record, event.sequence));
  }
  return points;
}

/**
 * 从事件流投影上下文事件日志。
 *
 * @param events 按 sequence 升序的 run 事件。
 * @returns 上下文事件条目（保持事件顺序）。
 */
export function buildContextEventEntries(events: readonly RunStreamEventDtoV2[]): ContextEventEntry[] {
  const entries: ContextEventEntry[] = [];
  for (const event of events) {
    if (event.type !== "context_event") continue;
    const payload = event.payload as ContextEventPayloadDto | null;
    if (!payload || typeof payload.tokensBefore !== "number" || typeof payload.tokensAfter !== "number") {
      continue;
    }
    const agentId =
      typeof (event.payload as { agentId?: unknown }).agentId === "string"
        ? ((event.payload as { agentId: string }).agentId ?? SUPERVISOR_AGENT_ID)
        : SUPERVISOR_AGENT_ID;
    entries.push({ eventId: event.eventId, sequence: event.sequence, agentId, payload });
  }
  return entries;
}

/**
 * 上下文事件日志（只要 payload，按事件顺序）。
 *
 * @param events 按 sequence 升序的 run 事件。
 * @returns `ContextEventPayloadDto[]`。
 */
export function buildContextEvents(events: readonly RunStreamEventDtoV2[]): ContextEventPayloadDto[] {
  return buildContextEventEntries(events).map((entry) => entry.payload);
}

/**
 * 计算上下文事件的净 token 变化。
 *
 * @param payload context_event 的 payload。
 * @returns 压缩前后与净增量。
 */
export function contextEventDelta(payload: ContextEventPayloadDto): ContextEventDelta {
  return {
    before: payload.tokensBefore,
    after: payload.tokensAfter,
    delta: payload.tokensAfter - payload.tokensBefore
  };
}

/**
 * 最近一次带 composition 的上下文点（Current Context 面板的数据源）。
 *
 * 取「最后一次有 composition 的点」而不是「最后一个点」：错误早退的调用没有构成快照，
 * 用它来展示会得到一个空面板。找不到时返回 undefined，由面板展示空态。
 *
 * @param points 上下文点序列。
 * @returns 最近一次可用的点。
 */
export function latestCompositionPoint(points: readonly ContextPoint[]): ContextPoint | undefined {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].composition) return points[index];
  }
  return undefined;
}

/**
 * 把 ✂ 标记钉到 Trend 的列位置上。
 *
 * compaction 在 run 开始前发射（sequence 早于任何 llm_call），因此它的位置是
 * 「第一根调用序号 ≥ 它的事件 sequence 的柱子之前」。返回 `insertBefore` 表示应插在该下标
 * 的柱子前；`columns.length` 表示钉在末尾（run 内压缩，未来扩展）。
 *
 * @param columns Trend 的柱序列（已按事件顺序）。
 * @param sequence 上下文事件的 sequence。
 * @returns 应插入的列下标（0..columns.length）。
 */
export function compactionColumnIndex(
  columns: readonly ContextTrendColumn[],
  sequence: number
): number {
  for (let index = 0; index < columns.length; index += 1) {
    if (columns[index].sequence > sequence) return index;
  }
  return columns.length;
}
