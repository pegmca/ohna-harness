/**
 * trace-context（docs/v2.0/04 §5.3 / §8）：上下文点与上下文事件的投影验收。
 *
 * 锁三件事：① 不重新估算（composition/window 直取采集记录）；② 实际用量缺失按 0；
 * ③ compaction 的位置锚点（✂ 钉在对应柱列之前）。
 */
import { describe, expect, it } from "vitest";
import type { ContextTrendColumn } from "./trace-context";
import {
  buildContextEventEntries,
  buildContextEvents,
  buildContextPoints,
  compactionColumnIndex,
  contextEventDelta,
  latestCompositionPoint,
  toContextPoint
} from "./trace-context";
import { llmRecord, llmRecordFor, runEvent, singleAgentEvents, teamRunEvents } from "./trace-fixtures";

describe("trace-context：上下文点投影", () => {
  it("window / composition / actual 直取记录，不做二次估算", () => {
    const points = buildContextPoints([runEvent(1, "llm_call", llmRecord)]);
    expect(points).toHaveLength(1);
    const [point] = points;
    expect(point.window).toEqual({ contextWindow: 128000, maxTokens: 4096, reserveTokens: 16384 });
    expect(point.composition).toEqual({ system: 3, tools: 0, user: 1, assistant: 0, toolResult: 0, total: 4 });
    expect(point.actual).toEqual({ input: 3, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(point.cost.total).toBe(0);
    expect(point.durationMs).toBe(42);
    expect(point.agentId).toBe("supervisor");
    // sequence 与点同源（Trend 的 ✂ 定位与柱列配对都靠它，不再由消费方另起一遍过滤）。
    expect(point.sequence).toBe(1);
  });

  it("错误路径记录：composition 为空但 window 仍在；actual/cost 缺失按 0", () => {
    const record = {
      ...llmRecord,
      response: undefined,
      error: { message: "boom" },
      composition: undefined
    };
    const point = toContextPoint(record);
    expect(point.composition).toBeUndefined();
    expect(point.window.contextWindow).toBe(128000);
    expect(point.actual).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(point.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  it("坏记录（缺 request）不进入上下文视图，与投影层同口径", () => {
    const points = buildContextPoints([runEvent(1, "llm_call", { callId: "x" }), runEvent(2, "llm_call", null)]);
    expect(points).toEqual([]);
  });

  it("Team run：子代理与主线程的点共存，保持事件顺序（callIndex 可能重号）", () => {
    const points = buildContextPoints(teamRunEvents());
    expect(points.map((point) => `${point.agentId}#${point.callIndex}`)).toEqual([
      "supervisor#1",
      "researcher#1",
      "spawn-agent#1",
      "supervisor#2"
    ]);
    // callIndex 在 Team 场景下不唯一（两条链各持一条序列），sequence 才是唯一配对键。
    expect(points.map((point) => point.sequence)).toEqual([4, 8, 16, 19]);
    expect(new Set(points.map((point) => point.sequence)).size).toBe(points.length);
  });
});

describe("trace-context：上下文事件投影", () => {
  it("buildContextEvents 返回 payload 序列（净回收为负）", () => {
    const events = buildContextEvents(singleAgentEvents());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "compaction", tokensBefore: 62000, tokensAfter: 12000 });
    expect(contextEventDelta(events[0]).delta).toBe(-50000);
  });

  it("entries 带 sequence 锚点与归属，供 Trend 定位", () => {
    const entries = buildContextEventEntries(singleAgentEvents());
    expect(entries).toHaveLength(1);
    expect(entries[0].sequence).toBe(1);
    expect(entries[0].agentId).toBe("supervisor");
  });

  it("缺 tokensBefore/After 的畸形 payload 被丢弃，不产生 NaN 日志", () => {
    expect(buildContextEvents([runEvent(1, "context_event", { kind: "compaction" })])).toEqual([]);
    expect(buildContextEvents([runEvent(1, "context_event", null)])).toEqual([]);
  });
});

describe("trace-context：面板取数与定位", () => {
  it("latestCompositionPoint 跳过没有 composition 的末尾调用", () => {
    const points = buildContextPoints([
      runEvent(1, "llm_call", llmRecordFor("supervisor", 1)),
      runEvent(2, "llm_call", llmRecordFor("supervisor", 2, { composition: undefined }))
    ]);
    expect(latestCompositionPoint(points)?.callIndex).toBe(1);
    expect(latestCompositionPoint([])).toBeUndefined();
  });

  it("compaction 早于所有调用时钉在第一根柱子之前", () => {
    const columns = [6, 11, 19].map((sequence) => ({ sequence }) as unknown as ContextTrendColumn);
    expect(compactionColumnIndex(columns, 1)).toBe(0);
    expect(compactionColumnIndex(columns, 8)).toBe(1);
    expect(compactionColumnIndex(columns, 12)).toBe(2);
    expect(compactionColumnIndex(columns, 30)).toBe(3);
  });

  it("硬依赖是 window：缺 window 的记录不进上下文视图（缺 request 只是同一时刻缺失的代理判据）", () => {
    const points = buildContextPoints([
      runEvent(1, "llm_call", llmRecordFor("supervisor", 1)),
      // 坏记录：window 缺失（构建顺序上 window 与 request 同生共死，这里单独构造以锁定判据）。
      runEvent(2, "llm_call", { ...llmRecordFor("supervisor", 2), window: undefined } as never)
    ]);
    expect(points.map((point) => point.callIndex)).toEqual([1]);
  });

  it("有 window 就进视图：usage/cost 缺失按 0，不因此被过滤", () => {
    const record = llmRecordFor("supervisor", 3, {
      response: { message: undefined, finishReason: undefined, usage: undefined } as never
    });
    const points = buildContextPoints([runEvent(1, "llm_call", record)]);
    expect(points).toHaveLength(1);
    expect(points[0].window.contextWindow).toBe(128000);
  });
});
