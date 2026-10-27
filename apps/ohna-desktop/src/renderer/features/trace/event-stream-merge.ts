/**
 * run 事件流的增量归并（纯函数，供 `use-trace-stream` 的数据编排层调用）。
 *
 * 为什么需要它（docs/v2.0/04 §5.4）：旧实现每帧都 `[...prev, event].sort()` 全量重排，
 * 500+ 事件的 live run 每帧 O(n log n) 且每帧都产生新数组引用，下游 `useMemo` 全部失效。
 * 这里把三种来源分开处理：
 * - **live 流**（sequence 严格单调递增）：直接 push，`O(1)` 摊销；
 * - **replay 一次性装载**：允许乱序，按 sequence 重排后再赋引用；
 * - **乱序回填**（续传/重放重复投递或迟到帧）：走二分插入归并，只在真的乱序时才付
 *   `O(n)` 复制成本——正常续传仍然命中最快的 append 分支。
 *
 * 去重口径是 sequence：同一 sequence 重复投递必须保持「引用不变」，否则下游 memo 会白算。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";

/**
 * 归一化一次事件投递的结果。
 *
 * `events` 的引用不变即表示「本次投递无需重渲染」：调用方可以据此跳过 `setState`。
 */
export interface MergeResult {
  /** 归一化之后的事件数组（可能复用入参引用）。 */
  events: readonly RunStreamEventDtoV2[];
  /** true 表示入参里存在乱序，走了归并路径。 */
  merged: boolean;
}

/**
 * 按 sequence 升序排序（稳定，返回新数组；用于 replay 一次性装载）。
 *
 * @param events 任意顺序的事件。
 * @returns 新数组（已按 sequence 升序）。
 */
export function sortBySequence(events: readonly RunStreamEventDtoV2[]): RunStreamEventDtoV2[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

/**
 * 增量归一：单调递增走 append，乱序才归并。
 *
 * @param previous 已有事件（假定已按 sequence 升序）。
 * @param incoming 新到的一帧。
 * @returns 归一化结果；`events` 引用不变表示重复投递、无需更新。
 */
export function mergeEvent(
  previous: readonly RunStreamEventDtoV2[],
  incoming: RunStreamEventDtoV2
): MergeResult {
  const last = previous[previous.length - 1];
  if (last === undefined || incoming.sequence > last.sequence) {
    // 快路径：live 流的常态（serve 的 emitFrame 同步分配 sequence，天然单调）。
    return { events: [...previous, incoming], merged: false };
  }
  const insertAt = lowerBound(previous, incoming.sequence);
  const existing = previous[insertAt];
  if (existing !== undefined && existing.sequence === incoming.sequence) {
    // 重复投递：保持引用，下游 useMemo 直接命中。
    return { events: previous, merged: false };
  }
  const next = previous.slice();
  next.splice(insertAt, 0, incoming);
  return { events: next, merged: true };
}

/**
 * 批量增量归一（replay 在恢复过程中分批投递时使用）。
 *
 * @param previous 已有事件。
 * @param incoming 新到的一批事件（可乱序、可含重复）。
 * @returns 归一化结果；全部重复时 `events` 引用不变。
 */
export function mergeEvents(
  previous: readonly RunStreamEventDtoV2[],
  incoming: readonly RunStreamEventDtoV2[]
): MergeResult {
  let current: readonly RunStreamEventDtoV2[] = previous;
  let merged = false;
  for (const event of incoming) {
    const result = mergeEvent(current, event);
    current = result.events;
    merged = merged || result.merged;
  }
  return { events: current, merged };
}

/**
 * 二分查找首个 `sequence >= target` 的下标。
 *
 * @param events 已按 sequence 升序的事件数组。
 * @param target 目标 sequence。
 * @returns 插入下标（0..length）。
 */
function lowerBound(events: readonly RunStreamEventDtoV2[], target: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].sequence < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
