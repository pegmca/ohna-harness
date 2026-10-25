/**
 * 执行地图与上下文三面板的组件验收（docs/v2.0/04 §6 / §8）。
 *
 * 覆盖 §8 点名的四条硬要求：
 * - Team 卡只出现在 Team run（单 run 退化为单 root，不出现编队区）；
 * - Composition 中 `reserveTokens` / `maxTokens` 掩码比例可见（fixture 窗口 128000 → 12.8% / 3.2%）；
 * - ✂ compaction 标记在 Trend 与 Events **两处**都出现；
 * - Turn 分组默认展开、失败 turn 有标记、500+ 事件不一次性挂载全部原始报文。
 */
import type { LlmCallRecordDto, RunStreamEventDtoV2 } from "@aiagent/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextComposition, layoutComposition } from "./ContextComposition";
import { ContextEvents } from "./ContextEvents";
import { ContextTrend, toTrendColumns } from "./ContextTrend";
import { ExecutionRibbon, summarizeExecution } from "./ExecutionRibbon";
import {
  buildContextEventEntries,
  buildContextPoints,
  compactionColumnIndex,
  latestCompositionPoint
} from "./trace-context";
import { CONTEXT_ESTIMATE_NOTE } from "./trace-labels";
import { projectTraceRows } from "./trace-projection";
import { buildTraceSpans, isTeamRun } from "./trace-spans";
import { llmRecord, llmRecordFor, runEvent, singleAgentEvents, teamRunEvents } from "./trace-fixtures";
import { VirtualizedLlmCallBlock } from "./LlmCallBlock.virtual";
import { TraceRowList } from "./TraceStream";
import { TraceTeamCards, isAgentRunning } from "./TraceTeamCards";
import {
  TURN_RENDER_BUDGET,
  TurnGroupList,
  bucketRowsByTurn,
  needsUngroupedHint,
  splitByBudget
} from "./TurnGroup";

describe("ExecutionRibbon", () => {
  it("step-brief 汇总 turn / step / llm / tool / 耗时 / 状态", () => {
    const events = singleAgentEvents();
    const rows = projectTraceRows(events);
    render(
      <ExecutionRibbon isLive={false} rows={rows} spans={buildTraceSpans(events)} status="completed" />
    );
    const brief = screen.getByRole("region", { name: "执行摘要" });
    expect(within(brief).getByText("turns").parentElement?.textContent).toContain("2");
    expect(within(brief).getByText("llm calls").parentElement?.textContent).toContain("2");
    expect(within(brief).getByText("tools").parentElement?.textContent).toContain("1");
    expect(within(brief).getByText("总耗时（LLM 累计）").parentElement?.textContent).toContain("84ms");
    expect(within(brief).getByText("completed")).toBeTruthy();
  });

  it("summarizeExecution 直接可断言（纯函数）", () => {
    const events = singleAgentEvents();
    const rows = projectTraceRows(events);
    const brief = summarizeExecution(rows, buildTraceSpans(events));
    expect(brief).toMatchObject({ turns: 2, llmCalls: 2, tools: 1, steps: rows.length, durationMs: 84 });
  });
});

describe("TraceTeamCards", () => {
  it("Team run 渲染成员卡（含角色 / 模型），可点击定位", () => {
    const spans = buildTraceSpans(teamRunEvents());
    const onSelect = vi.fn();
    render(<TraceTeamCards activeAgentId={undefined} isLive={false} onSelect={onSelect} spans={spans} />);
    const list = within(screen.getByRole("region", { name: "Team 成员" })).getByRole("list");
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(within(list).getAllByText("researcher").length).toBeGreaterThan(0);
    // 卡片就是按钮本身（role=listitem 覆盖在 button 上，无障碍名由 aria-label 提供）。
    fireEvent.click(cards[1]);
    expect(onSelect).toHaveBeenCalledWith("researcher");
  });

  it("单 run（非 Team）不渲染编队区", () => {
    const spans = buildTraceSpans(singleAgentEvents());
    expect(isTeamRun(spans)).toBe(false);
    // 单 run 退化为单 root：跨度集合只有一个 agent，编队区整体不渲染
    // （由抽屉层的 isTeamRun 把关，组件本身也不产出「一个成员的编队」）。
    const { container } = render(
      <TraceTeamCards activeAgentId={undefined} isLive={false} onSelect={() => {}} spans={spans} />
    );
    expect(spans.agents.size).toBe(1);
    expect(isTeamRun(spans)).toBe(false);
    expect(container.querySelector(".trace-team-card")).toBeNull();
  });

  it("运行中绿点：只有未收尾且活到最后的 agent 才是 running", () => {
    const spans = buildTraceSpans(teamRunEvents());
    // 终态事件流：整体不再 live，任何 agent 都不亮绿点。
    expect(isAgentRunning("supervisor", spans, false)).toBe(false);
    // live 场景下 researcher 已 agent_end（closed），只有 supervisor 仍是 running。
    expect(isAgentRunning("researcher", spans, true)).toBe(false);
    expect(isAgentRunning("supervisor", spans, true)).toBe(false);
  });
});


describe("TurnGroup", () => {
  it("默认全部展开，标题带 turn 序号与行数；点击可收起", () => {
    const events = singleAgentEvents();
    const rows = projectTraceRows(events);
    render(<TurnGroupList activeAgentId={undefined} events={events} isLive={false} rows={rows} />);
    const heads = screen.getAllByRole("button", { name: /Turn \d/ });
    expect(heads.map((head) => head.getAttribute("aria-expanded"))).toEqual(heads.map(() => "true"));
    expect(within(heads[0]).getByText("Turn 1")).toBeTruthy();
    fireEvent.click(heads[0]);
    expect(heads[0].getAttribute("aria-expanded")).toBe("false");
  });

  it("bucketRowsByTurn 用 sequence 锚点分桶：run 前导段并入首个 turn，终态行独立成 Run end", () => {
    const events = singleAgentEvents();
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    // 前导段 = seq 1 的 context_event 与 seq 2 的用户消息：它们早于 seq 4 的 turn_start(0)，
    // 因此并入紧随其后的首个 supervisor turn「Turn 1」，不另造前导桶。
    expect(buckets.map((bucket) => bucket.title)).toEqual(["Turn 1", "Turn 2", "Run end"]);
    expect(buckets.map((bucket) => bucket.rows.map((row) => row.kind))).toEqual([
      ["context", "message", "message", "llm", "tool"],
      ["llm"],
      ["terminal"]
    ]);
  });

  it("bucketRowsByTurn 纯前缀：context + message 早于任何 turn_start 时并入首个 turn，不出现 Before first turn", () => {
    // 与上一例的区别：这里前缀行之前没有任何 turn_start，直接命中「并入紧随其后的首个 turn」口径。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "context_event", { kind: "compaction", tokensBefore: 62000, tokensAfter: 12000 }),
      runEvent(2, "message_end", { type: "message_end", agentId: "supervisor", message: { role: "user", content: "hello" } }),
      runEvent(3, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
      runEvent(4, "llm_call", llmRecordFor("supervisor", 1))
    ];
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    expect(buckets.map((bucket) => bucket.title)).toEqual(["Turn 1"]);
    expect(buckets.map((bucket) => bucket.rows.map((row) => row.kind))).toEqual([
      ["context", "message", "llm"]
    ]);
  });

  it("bucketRowsByTurn 合法退化桶：该 agent 一条 turn_start 都没有时才出现 Before first turn", () => {
    // 兜底桶是**合法退化**：事件流里根本没有 turn 边界（例如只有 llm_call），此时没有 turn 可并入。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "agent_start", { agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "m" }),
      runEvent(2, "llm_call", llmRecordFor("supervisor", 1)),
      runEvent(3, "run_status", { status: "completed" })
    ];
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    expect(buckets.map((bucket) => bucket.title)).toEqual(["Before first turn", "Run end"]);
  });

  it("bucketRowsByTurn 首个 turn 之前出现的 supervisor 行不被挪走：仍归属紧随其后的 turn", () => {
    // 回归：旧实现在「supervisor 行出现在首个 turn 之前、但 current 已被推进」时，
    // 会把该行归到更早的 turn（跨轮挪行）。这里 turn 1 已开过，turn 2 之前夹一条 supervisor 消息，
    // 它必须留在 Turn 1（最近一次经过的 turn），而不是被并进 Turn 2。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
      runEvent(2, "llm_call", llmRecordFor("supervisor", 1)),
      runEvent(3, "turn_end", { type: "turn_end", agentId: "supervisor", turnIndex: 0 }),
      runEvent(4, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 1 }),
      runEvent(5, "llm_call", llmRecordFor("supervisor", 2))
    ];
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    expect(buckets.map((bucket) => bucket.title)).toEqual(["Turn 1", "Turn 2"]);
    expect(buckets.map((bucket) => bucket.rows.length)).toEqual([1, 1]);
  });

  it("bucketRowsByTurn：子代理的游离行不并进主线程的 turn（按本 agent 的 turn 判定）", () => {
    // 子代理没有自己的 turn_start 时，它的行只能进它自己的退化桶，不能因为「最近经过的是
    // supervisor 的 turn」就被塞进主线程桶（串台）。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
      runEvent(2, "llm_call", llmRecordFor("supervisor", 1)),
      runEvent(3, "llm_call", llmRecordFor("researcher", 1))
    ];
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    expect(buckets.map((bucket) => `${bucket.agentId}:${bucket.turnIndex}`)).toEqual([
      "supervisor:0",
      "researcher:-1"
    ]);
    expect(buckets[1].title).toBe("researcher · before first turn");
  });

  it("失败 turn 着色：turn 内出现错误行即标记 is-failed", () => {
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "agent_start", { agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "m" }),
      runEvent(2, "turn_start", { agentId: "supervisor", turnIndex: 0 }),
      runEvent(3, "llm_call", {
        ...llmRecord,
        response: undefined,
        error: { message: "provider 401" }
      } as unknown as LlmCallRecordDto)
    ];
    const failedRows = projectTraceRows(events);
    expect(failedRows.some((row) => row.kind === "llm" && Boolean(row.record.error))).toBe(true);
    const { container } = render(
      <TurnGroupList activeAgentId={undefined} events={events} isLive={false} rows={failedRows} />
    );
    expect(container.querySelector(".trace-turn.is-failed")).toBeTruthy();
  });

  it("渲染预算：超过 TURN_RENDER_BUDGET 的 turn 只先挂载一批，按需再加载", () => {
    // 构造一个 turn 内 500+ 行的 llm 调用事件（每条都是真实 llm 行）。
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "agent_start", { agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "m" }),
      runEvent(2, "turn_start", { agentId: "supervisor", turnIndex: 0 })
    ];
    for (let index = 1; index <= 520; index += 1) {
      events.push(runEvent(index + 2, "llm_call", llmRecordFor("supervisor", index)));
    }
    const rows = projectTraceRows(events);
    const { container } = render(
      <TurnGroupList activeAgentId={undefined} events={events} isLive={false} rows={rows} />
    );
    // 只挂载预算内的行：原始报文（providerPayload）不会一次性全部进 DOM。
    const mounted = container.querySelectorAll(".trace-row-slot[data-mounted='true']");
    expect(mounted.length).toBeLessThanOrEqual(TURN_RENDER_BUDGET);
    const stay = screen.getByRole("button", { name: /再显示 40 行/ });
    fireEvent.click(stay);
    expect(
      container.querySelectorAll(".trace-row-slot[data-mounted='true']").length
    ).toBeGreaterThan(TURN_RENDER_BUDGET);
  });

  it("live run 在展开的 turn 标题上显示 running 指示", () => {
    const events = singleAgentEvents();
    const { container } = render(
      <TurnGroupList
        activeAgentId={undefined}
        events={events}
        isLive
        rows={projectTraceRows(events)}
      />
    );
    expect(container.querySelectorAll(".trace-live-dot").length).toBeGreaterThan(0);
  });
});

describe("行级归因联动（Team 卡点击）", () => {
  it("TraceRowList：只有选中 agent 的行带 is-agent-active，其余行照常渲染", () => {
    const rows = projectTraceRows(teamRunEvents());
    const { container } = render(<TraceRowList activeAgentId="researcher" rows={rows} />);
    const all = [...container.querySelectorAll(".trace-map-row")];
    expect(all.length).toBe(rows.length);
    const active = all.filter((row) => row.classList.contains("is-agent-active"));
    expect(active.length).toBeGreaterThan(0);
    for (const row of active) {
      expect(row.getAttribute("data-agent-key")).toBe("researcher");
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(row.getAttribute("data-agent-active")).toBe("true");
    }
    // 主线程（supervisor）的行仍存在但不高亮——执行地图不隐藏任何归属。
    expect(all.some((row) => row.getAttribute("data-agent-key") === "supervisor")).toBe(true);
  });

  it("TraceRowList：无选中时没有任何行高亮（默认态不干扰阅读）", () => {
    const rows = projectTraceRows(teamRunEvents());
    const { container } = render(<TraceRowList rows={rows} />);
    expect(container.querySelectorAll(".is-agent-active").length).toBe(0);
    expect(container.querySelectorAll("[aria-current]").length).toBe(0);
  });

  it("TurnGroup 把选中态落到各 turn 桶的行上，且每个桶仍按行归属分组", () => {
    const events = teamRunEvents();
    const rows = projectTraceRows(events);
    const { container } = render(
      <TurnGroupList activeAgentId="researcher" events={events} isLive={false} rows={rows} />
    );
    const turns = [...container.querySelectorAll(".trace-turn")];
    const researcherTurn = turns.find((turn) =>
      turn.getAttribute("aria-label")?.includes("researcher")
    );
    expect(researcherTurn).toBeTruthy();
    const inTurn = [...researcherTurn!.querySelectorAll(".trace-map-row")];
    // 分桶遵循按键归属：子代理 turn 桶里只有它自己的行（主线程行不会串进来）。
    expect(inTurn.every((row) => row.getAttribute("data-agent-key") === "researcher")).toBe(true);
    const active = inTurn.filter((row) => row.classList.contains("is-agent-active"));
    expect(active.length).toBe(inTurn.length);
    // 其他桶（主线程 turn）的行仍在渲染，只是不高亮。
    const otherRows = [...container.querySelectorAll(".trace-map-row")].filter(
      (row) => row.getAttribute("data-agent-key") !== "researcher"
    );
    expect(otherRows.length).toBeGreaterThan(0);
    expect(otherRows.some((row) => row.classList.contains("is-agent-active"))).toBe(false);
  });
});

describe("视口惰性挂载：未挂载分支是可读摘要而非空占位", () => {
  it("占位内存在摘要文案（#N · model · 耗时），并保留失败徽标", () => {
    const record = { ...llmRecordFor("supervisor", 3), error: { message: "provider 401", stopReason: "error" } };
    const { container } = render(
      <VirtualizedLlmCallBlock forcePlaceholder idSuffix="manual" record={record as never} />
    );
    const slot = container.querySelector(".trace-row-slot");
    expect(slot?.getAttribute("data-mounted")).toBe("false");
    const summary = container.querySelector(".trace-llm-summary");
    expect(summary).toBeTruthy();
    expect(summary?.getAttribute("aria-label")).toContain("#3");
    expect(summary?.getAttribute("aria-label")).toContain("stub-model");
    expect(summary?.textContent).toContain("stub-model");
    // 未挂载分支不得出现原始报文入口（raw tab 才是渲染预算要压住的重物）。
    expect(container.textContent).not.toContain("providerPayload");
  });

  it("观测器缺失的环境（jsdom）默认直接挂载，功能优先于预算", () => {
    const { container } = render(<VirtualizedLlmCallBlock idSuffix="eager" record={llmRecord} />);
    expect(container.querySelector(".trace-row-slot")?.getAttribute("data-mounted")).toBe("true");
  });
});

describe("前缀桶 / compaction 行的可见性（真实 sequence 顺序）", () => {
  /**
   * 构造真实顺序的事件流：`context_event` 在 seq 1（agent_start 之前），
   * 大量 `llm_call` 早于 `turn_start`，模拟真实 run 的前导段。
   *
   * @param calls llm_call 条数。
   * @param contextSeq context_event 的 sequence。
   * @returns 事件流。
   */
  function prefixRun(calls: number, contextSeq: number): RunStreamEventDtoV2[] {
    const events: RunStreamEventDtoV2[] = [];
    let seq = 1;
    const callSeqs: number[] = [];
    for (let index = 1; index <= calls; index += 1) {
      if (seq === contextSeq) seq += 1;
      callSeqs.push(seq);
      events.push(runEvent(seq, "llm_call", llmRecordFor("supervisor", index) as never));
      seq += 1;
    }
    events.unshift(
      runEvent(contextSeq, "context_event", {
        kind: "compaction",
        tokensBefore: 62000,
        tokensAfter: 12000
      } as never) as RunStreamEventDtoV2
    );
    events.push(runEvent(seq, "turn_start", { agentId: "supervisor", turnIndex: 0 }));
    events.push(runEvent(seq + 1, "turn_end", { agentId: "supervisor", turnIndex: 0 }));
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  it("splitByBudget 原位口径：context 行落在中间时，可见区仍是「预算内行 + 该行」的原始行序", () => {
    // budget=3，context 行落在下标 2（预算之内），因此可见区就是原始前 3 行、顺序不变：
    // 既不该被 `slice(0, budget)` 之外的规则改写，也不该被提到 visible[0]。
    const events = prefixRun(6, 3);
    const rows = projectTraceRows(events);
    const bucket = bucketRowsByTurn(rows, events)[0];
    const budget = 3;
    const contextIndex = bucket.rows.findIndex((row) => row.kind === "context");
    // 前提：context 行在预算之内且不在首位（否则区分不出「原位」与「置顶」）。
    expect(contextIndex).toBeGreaterThan(0);
    expect(contextIndex).toBeLessThan(budget);
    const { visible, hidden } = splitByBudget(bucket.rows, budget);
    // 顺序断言（可失败）：可见区逐行等于原始行序的可见子序列。
    // `shownRest` 独立计数（不照抄实现的下标写法，否则会跟着实现一起错）。
    let shownRest = 0;
    const expectedKeys = bucket.rows
      .filter((row) => {
        if (row.kind === "context") return true;
        const keep = shownRest < budget;
        shownRest += 1;
        return keep;
      })
      .map((row) => row.key);
    expect(visible.map((row) => row.key)).toEqual(expectedKeys);
    // context 行不被置顶：它的位置仍由时间序决定。
    expect(visible[0].kind).not.toBe("context");
    expect(hidden.every((row) => row.kind !== "context")).toBe(true);
  });

  it("splitByBudget：context 行无条件进可见区，位置再靠后也不被折叠", () => {
    const rows = projectTraceRows(prefixRun(60, 61));
    const bucket = bucketRowsByTurn(rows, prefixRun(60, 61))[0];
    const contextIndex = bucket.rows.findIndex((row) => row.kind === "context");
    // 前提：这一行确实落在预算之外（否则本用例测不到东西）。
    expect(contextIndex).toBeGreaterThanOrEqual(TURN_RENDER_BUDGET);
    const { visible, hidden, remaining } = splitByBudget(bucket.rows, TURN_RENDER_BUDGET);
    expect(visible.some((row) => row.kind === "context")).toBe(true);
    // 可见区仍然只放预算内的非 context 行。
    expect(visible.filter((row) => row.kind !== "context").length).toBe(TURN_RENDER_BUDGET);
    expect(remaining).toBe(bucket.rows.length - visible.length);
    // 原位口径的第二条守护：预算之外的 context 行进可见区，但**排在它真实的位置**
    // ——即排在全部预算内行之后、hidden 之前，而不是被提到 visible[0]。
    expect(visible[0].kind).not.toBe("context");
    expect(visible[visible.length - 1].kind).toBe("context");
    // context 行不进 hidden（否则点「再显示」时会被重复渲染）。
    expect(hidden.some((row) => row.kind === "context")).toBe(false);
  });

  it("TurnGroup 默认展开时 ✂ 横条直接可读，无需点「再显示」", () => {
    const events = prefixRun(60, 61);
    const rows = projectTraceRows(events);
    const { container } = render(
      <TurnGroupList activeAgentId={undefined} events={events} isLive={false} rows={rows} />
    );
    expect(container.querySelectorAll(".trace-context-row").length).toBe(1);
    // 预算按钮仍在（其余行确实被折叠），但 context 行不在它之后。
    expect(screen.getAllByRole("button", { name: /再显示/ }).length).toBeGreaterThan(0);
  });

  it("context_event 在 seq 1、llm_call 早于 turn_start：仍归入首个 turn 而非丢失", () => {
    const events = prefixRun(3, 1);
    const rows = projectTraceRows(events);
    const buckets = bucketRowsByTurn(rows, events);
    expect(buckets[0].title).toBe("Turn 1");
    expect(buckets[0].rows.some((row) => row.kind === "context")).toBe(true);
  });

  it("无任何行时 TurnGroupList 返回 null（抽屉空态接管）", () => {
    const { container } = render(
      <TurnGroupList activeAgentId={undefined} events={[]} isLive={false} rows={[]} />
    );
    expect(container.querySelector(".trace-turns")).toBeNull();
  });

  it("有行却零分组（防御分支）：needsUngroupedHint 判定 + 注入空 buckets 时只出提示、不渲染 .trace-turns", () => {
    // 这是**纯防御分支**：正常分桶下每行必然进桶或进 Run end，因此不可由渲染自然触发。
    // 守护方式是 (a)：判定抽成纯函数 + 测试直接注入空 buckets，真正断言提示文案出现、列表不出现。
    // 判定函数：有行无桶为真，其余组合为假（不是恒真断言）。
    expect(needsUngroupedHint(3, 0)).toBe(true);
    expect(needsUngroupedHint(0, 0)).toBe(false);
    expect(needsUngroupedHint(3, 1)).toBe(false);
    expect(needsUngroupedHint(0, 1)).toBe(false);
    const rows = projectTraceRows(singleAgentEvents());
    const { container } = render(
      <TurnGroupList activeAgentId={undefined} buckets={[]} events={singleAgentEvents()} isLive={false} rows={rows} />
    );
    // 提示出现（含行数），且执行地图容器整体不出现。
    const hint = container.querySelector(".trace-empty");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain(`${rows.length} 条事件`);
    expect(container.querySelector(".trace-turns")).toBeNull();
    expect(container.querySelectorAll(".trace-turn").length).toBe(0);
    // 对照组：正常分桶时注入点不被使用，列表照常渲染、提示不出现。
    const normal = render(
      <TurnGroupList activeAgentId={undefined} events={singleAgentEvents()} isLive={false} rows={rows} />
    );
    expect(normal.container.querySelector(".trace-turns")).not.toBeNull();
    expect(normal.container.querySelector(".trace-empty")).toBeNull();
  });

  it("bucketRowsByTurn：agentId 含 `:` 时归属不被分隔符截断", () => {
    const events: RunStreamEventDtoV2[] = [
      runEvent(1, "agent_start", { agentId: "ns:worker", label: "w", role: "worker", modelId: "m" }),
      runEvent(2, "turn_start", { agentId: "ns:worker", turnIndex: 0 }),
      runEvent(3, "llm_call", llmRecordFor("ns:worker", 1) as never),
      runEvent(4, "turn_start", { agentId: "supervisor", turnIndex: 0 }),
      runEvent(5, "llm_call", llmRecordFor("supervisor", 1) as never)
    ];
    const buckets = bucketRowsByTurn(projectTraceRows(events), events);
    expect(buckets.map((bucket) => `${bucket.agentId}:${bucket.turnIndex}`)).toEqual([
      "ns:worker:0",
      "supervisor:0"
    ]);
    expect(buckets.map((bucket) => bucket.rows.length)).toEqual([1, 1]);
  });
});
