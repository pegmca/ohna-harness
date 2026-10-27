/**
 * 上下文 / Token 三面板的组件验收（docs/v2.0/04 §5/§6/§8）。
 *
 * 覆盖 §8 点名的硬要求：Composition 中 `reserveTokens` / `maxTokens` 掩码比例可见
 * （fixture 窗口 128000 → 12.8% / 3.2%）；✂ compaction 标记在 Trend 与 Events **两处**都出现；
 * 三面板共用同一条估算脚注（且文案方向是「低估」而非「高估」）。
 *
 * 执行地图（Ribbon / TeamCards / TurnGroup / 行级归因 / 渲染预算）的验收在
 * `trace-map-execution.test.tsx`；共享 fixture 在 `trace-fixtures.ts`。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextComposition, layoutComposition } from "./ContextComposition";
import { ContextEvents } from "./ContextEvents";
import { ContextTrend, toTrendColumns } from "./ContextTrend";
import {
  buildContextEventEntries,
  buildContextPoints,
  compactionColumnIndex,
  latestCompositionPoint
} from "./trace-context";
import { CONTEXT_ESTIMATE_NOTE } from "./trace-labels";
import { llmRecord, llmRecordFor, runEvent, singleAgentEvents } from "./trace-fixtures";

describe("ContextComposition", () => {
  it("窗口 / 预留 / 输出上限的比例可直接读出（fixture 128000 窗口）", () => {
    const point = buildContextPoints([runEvent(1, "llm_call", llmRecord)])[0];
    const layout = layoutComposition(point);
    // 100% = contextWindow；预留 16384 → 12.8%，输出上限 4096 → 3.2%。
    const reserve = layout.segments.find((segment) => segment.key === "reserve");
    const output = layout.segments.find((segment) => segment.key === "output");
    expect(reserve?.hatch).toBe(true);
    expect(reserve?.percent).toBeCloseTo(12.8, 1);
    expect(output?.percent).toBeCloseTo(3.2, 1);
    expect(layout.usedPercent).toBeCloseTo((4 / 128000) * 100, 4);
    expect(layout.segments.filter((segment) => !segment.hatch).map((segment) => segment.key)).toEqual([
      "system",
      "tools",
      "user",
      "assistant",
      "toolResult"
    ]);
  });

  it("渲染分类段 + 两个掩码，并共用同一条估算脚注", () => {
    const point = buildContextPoints([runEvent(1, "llm_call", llmRecord)])[0];
    const { container } = render(<ContextComposition point={point} />);
    expect(screen.getByRole("region", { name: "Current Context" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "上下文窗口构成" })).toBeTruthy();
    expect(container.querySelectorAll(".trace-stack-seg:not(.is-hatch)")).toHaveLength(5);
    const masks = container.querySelectorAll(".trace-stack-seg.is-hatch");
    expect(masks).toHaveLength(2);
    expect(Number(masks[0].getAttribute("data-percent"))).toBeCloseTo(12.8, 1);
    expect(Number(masks[1].getAttribute("data-percent"))).toBeCloseTo(3.2, 1);
    expect(screen.getAllByText(CONTEXT_ESTIMATE_NOTE)).toHaveLength(1);
  });

  it("无 composition（错误路径）时给出空态而不是 0 值堆叠", () => {
    render(<ContextComposition point={undefined} />);
    expect(screen.getByText(/尚无带窗口构成的 LLM 调用/)).toBeTruthy();
  });
});

describe("ContextTrend 与 ContextEvents", () => {
  it("✂ 在 Trend 与 Events 两处都出现", () => {
    const events = singleAgentEvents();
    const points = buildContextPoints(events);
    const entries = buildContextEventEntries(events);

    const trend = render(<ContextTrend entries={entries} points={points} />);
    expect(screen.getByRole("img", { name: "每次 LLM 请求的窗口占用" })).toBeTruthy();
    // Trend 里的 ✂ 带 role 语义（可被读屏定位），因此 aria-label 命中 1 个、class 命中 1 个。
    expect(trend.container.querySelectorAll('.trace-trend-mark[data-context-mark="compaction"]')).toHaveLength(1);
    expect(screen.getAllByLabelText("compaction 压缩")).toHaveLength(1);
    trend.unmount();

    const eventsPanel = render(<ContextEvents entries={entries} />);
    expect(screen.getByRole("region", { name: "Context Events" })).toBeTruthy();
    expect(eventsPanel.container.querySelectorAll('[data-context-mark="compaction"]')).toHaveLength(1);
    // 净回收以负值展示，before → after 可读。
    expect(screen.getAllByText("-50,000 tokens").length).toBeGreaterThan(0);
    expect(screen.getByText("62,000 → 12,000")).toBeTruthy();
    // 每个面板各自渲染一份同一常量（文案只有一处定义）。
    expect(screen.getAllByText(CONTEXT_ESTIMATE_NOTE).length).toBeGreaterThan(0);
  });

  it("回归：坏记录被上下文投影过滤后，柱列的 sequence 锚点不错位（✂ 仍钉在正确位置）", () => {
    // 旧实现由消费方另起一遍 `type === "llm_call"` 过滤出 callSequences，与投影层
    // 「缺 request/window 则跳过」的口径不同：一条坏记录会让其后每根柱子都挂到上一条
    // 记录的 sequence 上，✂ 因此钉错一格。现在 sequence 随点自带，配对是恒等映射。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "llm_call", llmRecordFor("supervisor", 1)),
      // 坏记录：缺 window（构建顺序上 window 与 request 同生共死），投影层会跳过它。
      runEvent(2, "llm_call", { ...llmRecordFor("supervisor", 2), window: undefined } as never),
      runEvent(3, "context_event", { kind: "compaction", tokensBefore: 5000, tokensAfter: 1000 }),
      runEvent(4, "llm_call", llmRecordFor("supervisor", 3))
    ];
    const points = buildContextPoints(events);
    expect(points.map((point) => point.sequence)).toEqual([1, 4]);
    const columns = toTrendColumns(points);
    expect(columns.map((column) => column.sequence)).toEqual([1, 4]);
    // seq 3 的 compaction 落在 seq 4 那一柱之前（下标 1），而不是被错位挤到末尾。
    expect(compactionColumnIndex(columns, 3)).toBe(1);
    const { container } = render(
      <ContextTrend entries={buildContextEventEntries(events)} points={points} />
    );
    const track = container.querySelector(".trace-trend")!;
    // DOM 顺序：柱 0 → ✂ → 柱 1。
    const kinds = Array.from(track.children).map((node) =>
      node.getAttribute("data-context-mark") === "compaction" ? "mark" : "col"
    );
    expect(kinds).toEqual(["col", "mark", "col"]);
  });

  it("context_event 早于所有调用时 ✂ 钉在第一根柱子之前", () => {
    const events = singleAgentEvents();
    const entries = buildContextEventEntries(events);
    const { container } = render(<ContextTrend entries={entries} points={buildContextPoints(events)} />);
    const track = container.querySelector(".trace-trend")!;
    // 标记出现在第一根柱列之前。
    expect(track.firstElementChild?.getAttribute("data-context-mark")).toBe("compaction");
  });
});

describe("上下文三面板共用同一条估算脚注", () => {
  it("脚注措辞明确说明 chars÷4 会低估中文 token", () => {
    expect(CONTEXT_ESTIMATE_NOTE).toContain("低估");
    const point = latestCompositionPoint(buildContextPoints(singleAgentEvents()));
    expect(point).toBeTruthy();
  });
});

