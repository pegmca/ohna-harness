/**
 * event-stream-merge（docs/v2.0/04 §5.4 / §8）：增量归并验收。
 *
 * 断言三件事：① 单调递增走 append 且不排序；② 重复投递保持数组引用（下游 useMemo 命中）；
 * ③ 真正的乱序回填才走归并，并且结果仍然有序。
 */
import { describe, expect, it } from "vitest";
import { mergeEvent, mergeEvents, sortBySequence } from "./event-stream-merge";
import { runEvent } from "./trace-fixtures";

/**
 * 构造一条 message_end 事件（sequence 决定顺序）。
 *
 * @param sequence 序号。
 * @returns run 事件。
 */
function event(sequence: number) {
  return runEvent(sequence, "message_end", { message: { role: "assistant", content: `${sequence}` } });
}

describe("event-stream-merge", () => {
  it("sequence 单调递增：直接 append，不打乱既有引用", () => {
    const first = mergeEvent([], event(1));
    expect(first.merged).toBe(false);
    expect(first.events.map((item) => item.sequence)).toEqual([1]);

    const previous = first.events;
    const second = mergeEvent(previous, event(2));
    expect(second.merged).toBe(false);
    expect(second.events.map((item) => item.sequence)).toEqual([1, 2]);
    // 头部两个元素复用同一批事件对象（只追加，不重建）。
    expect(second.events[0]).toBe(previous[0]);
  });

  it("重复投递同一 sequence：返回原引用（免重渲染）", () => {
    const current = mergeEvent(mergeEvent([], event(1)).events, event(2)).events;
    const duplicate = mergeEvent(current, event(2));
    expect(duplicate.events).toBe(current);
    expect(duplicate.merged).toBe(false);
  });

  it("乱序回填：二分插入归并，结果保持升序", () => {
    const base = sortBySequence([event(1), event(3), event(5)]);
    const late = mergeEvent(base, event(2));
    expect(late.merged).toBe(true);
    expect(late.events.map((item) => item.sequence)).toEqual([1, 2, 3, 5]);
    const later = mergeEvent(late.events, event(4));
    expect(later.merged).toBe(true);
    expect(later.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("批量归并：含乱序与重复的混投仍得到有序去重结果", () => {
    const result = mergeEvents(sortBySequence([event(2), event(4)]), [event(1), event(4), event(3)]);
    expect(result.merged).toBe(true);
    expect(result.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    // 全为重复时不改引用。
    const repeated = mergeEvents(result.events, [event(1), event(3)]);
    expect(repeated.events).toBe(result.events);
  });

  it("sortBySequence 返回新数组且稳定", () => {
    const input = [event(3), event(1), event(2)];
    const sorted = sortBySequence(input);
    expect(sorted.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(input.map((item) => item.sequence)).toEqual([3, 1, 2]);
  });
});
