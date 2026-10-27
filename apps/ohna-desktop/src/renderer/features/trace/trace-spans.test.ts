/**
 * trace-spans（docs/v2.0/04 §5.2 / §8）：按键归属的执行地图验收。
 *
 * 核心断言是「子代理与主线程事件交错时归属正确」——这是整个执行地图的地基，
 * 一旦退化成按 sequence 区间切割，Team run 的事件就会被算到错误的 turn 上。
 */
import { describe, expect, it } from "vitest";
import { buildTraceSpans, isTeamRun, listAgentSpans, turnKey } from "./trace-spans";
import {
  agentStartPayload,
  llmRecordFor,
  realOrderEvents,
  runEvent,
  singleAgentEvents,
  teamRunEvents
} from "./trace-fixtures";

describe("trace-spans：Agent 森林与 Turn 归属", () => {
  it("单 run（非 Team）退化为单 root 跨度，turn 按 turnIndex 排列", () => {
    const spans = buildTraceSpans(singleAgentEvents());
    expect(spans.rootAgentId).toBe("supervisor");
    expect([...spans.agents.keys()]).toEqual(["supervisor"]);
    expect(isTeamRun(spans)).toBe(false);
    expect(spans.turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    // turn 0 的首尾锚点覆盖它自己的事件（llm_call + tool），但不跨越 turn_start(1)。
    const [first] = spans.turns;
    expect(first.startSeq).toBe(4);
    expect(first.endSeq).toBe(9);
    expect(spans.turns[1].startSeq).toBe(10);
    expect(spans.turns[1].endSeq).toBe(12);
    // agent 跨度首尾锚点 = agent_start / agent_end。
    expect(spans.agents.get("supervisor")?.startSeq).toBe(3);
    expect(spans.agents.get("supervisor")?.endSeq).toBe(13);
  });

  it("Team run：按 (agentId, turnIndex) 键归属，交错事件不串台", () => {
    const spans = buildTraceSpans(teamRunEvents());
    expect(isTeamRun(spans)).toBe(true);
    expect(spans.rootAgentId).toBe("supervisor");
    // 森林：supervisor 为根，两个子代理挂在它下面（parentId 来自 agent_start）。
    expect(spans.agents.get("supervisor")?.children).toEqual(["researcher", "spawn-agent"]);
    expect(spans.agents.get("researcher")?.parentId).toBe("supervisor");
    expect(spans.agents.get("spawn-agent")?.parentId).toBe("supervisor");
    expect(spans.agents.get("researcher")?.role).toBe("researcher");
    // 子代理跨度只覆盖自己那段（agent_start 6 → agent_end 11），不被 supervisor 的后续事件撑大。
    expect(spans.agents.get("researcher")?.startSeq).toBe(6);
    expect(spans.agents.get("researcher")?.endSeq).toBe(11);
    expect(spans.agents.get("spawn-agent")?.startSeq).toBe(14);
    expect(spans.agents.get("spawn-agent")?.endSeq).toBe(18);

    // turn 归属：每个 agent 各有自己的 turn 0 / 1，互不覆盖。
    const keyed = spans.turns.map((turn) => `${turn.agentId}#${turn.turnIndex}@${turn.startSeq}`);
    expect(keyed).toEqual([
      "supervisor#0@2",
      "researcher#0@7",
      "supervisor#1@13",
      "spawn-agent#0@15"
    ]);
    const researcherTurn = spans.turns.find((turn) => turn.agentId === "researcher");
    // researcher 的 turn 只包住它自己的 7..10，不含主线程在 9 的工具结果、也不含 supervisor turn_end(12)。
    expect(researcherTurn).toMatchObject({ turnIndex: 0, startSeq: 7, endSeq: 10 });
    const supervisorTurn1 = spans.turns.find((turn) => turn.agentId === "supervisor" && turn.turnIndex === 1);
    // supervisor 的 turn 1 起点是 13；期间混入的 spawn-agent 事件（14..18）不会把它切碎，
    // 而是把锚点推进到 20（它自己的 turn_end）——这就是「区间只作锚点」的语义。
    expect(supervisorTurn1).toMatchObject({ startSeq: 13, endSeq: 20 });

    // 回归（docs/v2.0/03 §10 归因键唯一性）：turnIndex 是 per agent 从 0 起算的回合号，
    // 同一个 turnIndex 在 Team run 内会重号——因此**裸 turnIndex 不是唯一键**，
    // 只有 (agentId, turnIndex) 这一对才是。这里把「重号确实存在」与「键仍唯一」同时锁住，
    // 防止后续有人把 span 索引退回成 `Map<turnIndex, …>`。
    expect(spans.turns.map((turn) => turn.turnIndex)).toEqual([0, 0, 1, 0]);
    expect(new Set(spans.turns.map((turn) => turn.turnIndex)).size).toBe(2);
    expect(new Set(spans.turns.map((turn) => turnKey(turn.agentId, turn.turnIndex))).size).toBe(4);
    // turnKey 用 JSON 数组编码，agentId 含 `:` 时也不会与其它组合撞键。
    expect(turnKey("a:b", 1)).not.toBe(turnKey("a", "b:1" as unknown as number));

    // 成员顺序 = 首次出现顺序（TeamCards 不重排）。
    expect(listAgentSpans(spans).map((span) => span.agentId)).toEqual([
      "supervisor",
      "researcher",
      "spawn-agent"
    ]);
  });

  it("重复的 agent_start / turn_start（续传重放）不产生第二条跨度", () => {
    const events = [
      runEvent(1, "agent_start", { type: "agent_start", agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "m" }),
      runEvent(2, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
      runEvent(3, "agent_start", { type: "agent_start", agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "m" }),
      runEvent(4, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 })
    ];
    const spans = buildTraceSpans(events);
    expect([...spans.agents.keys()]).toEqual(["supervisor"]);
    expect(spans.turns).toHaveLength(1);
    expect(spans.turns[0]).toMatchObject({ startSeq: 2, endSeq: 4 });
  });

  it("没有 agent_start 的事件流：仍然给出 supervisor 根节点（归属语义兜底）", () => {
    const spans = buildTraceSpans(realOrderEvents());
    expect(spans.rootAgentId).toBe("supervisor");
    expect(spans.agents.get("supervisor")?.label).toBe("supervisor");
    expect(isTeamRun(spans)).toBe(false);
  });

  it("空事件流：单 root 跨度，不返回 undefined", () => {
    const spans = buildTraceSpans([]);
    expect(spans.rootAgentId).toBe("supervisor");
    expect(spans.turns).toEqual([]);
    expect(spans.agents.size).toBe(1);
  });

  it("Team run：turns 按键归属，主线程与两个子代理各成跨度、互不覆盖", () => {
    const spans = buildTraceSpans(teamRunEvents());
    // 交错形态下按 (agentId, turnIndex) 归属：supervisor 有 2 轮，两个子代理各 1 轮。
    const summary = spans.turns.map((turn) => `${turn.agentId}:${turn.turnIndex}`);
    // 顺序 = 事件到达顺序（不是按 turnIndex 排序）：supervisor 第 2 轮开启后 spawn-agent 才入场。
    expect(summary).toEqual(["supervisor:0", "researcher:0", "supervisor:1", "spawn-agent:0"]);
    // 每条跨度都以自己的 [startSeq, endSeq] 为锚点，且落在自己 agent 的边界事件之间。
    for (const turn of spans.turns) {
      expect(turn.endSeq).toBeGreaterThanOrEqual(turn.startSeq);
      const agent = spans.agents.get(turn.agentId);
      expect(agent).toBeDefined();
      expect(turn.startSeq).toBeGreaterThanOrEqual(agent!.startSeq);
      expect(turn.endSeq).toBeLessThanOrEqual(agent!.endSeq);
    }
    // 子代理跨度不吞并主线程轮次：researcher 的跨度区间内不包含 supervisor 的第 2 轮起点。
    const supervisorTurn2 = spans.turns.find((t) => t.agentId === "supervisor" && t.turnIndex === 1)!;
    const researcher = spans.turns.find((t) => t.agentId === "researcher")!;
    expect(researcher.startSeq).not.toBe(supervisorTurn2.startSeq);
    expect(isTeamRun(spans)).toBe(true);
  });

  it("同一 (agentId, turnIndex) 重复出现时合并为单一跨度（起点最早、终点最晚）", () => {
    const events = [
      runEvent(1, "agent_start", agentStartPayload("supervisor", undefined, "supervisor", "supervisor")),
      runEvent(2, "turn_start", { agentId: "supervisor", turnIndex: 0 }),
      runEvent(3, "turn_end", { agentId: "supervisor", turnIndex: 0 }),
      // 续传重放：同一 turn 再次 turn_start（内核不会产生，但重放/断点续传下消费侧要容忍）。
      runEvent(4, "turn_start", { agentId: "supervisor", turnIndex: 0 }),
      runEvent(5, "turn_end", { agentId: "supervisor", turnIndex: 0 })
    ];
    const spans = buildTraceSpans(events as never);
    expect(spans.turns).toHaveLength(1);
    expect(spans.turns[0]).toMatchObject({ agentId: "supervisor", turnIndex: 0, startSeq: 2, endSeq: 5 });
  });

  it("agentId 含 `:` 时归属不被截断（键编码不得靠分隔符）", () => {
    const events = [
      runEvent(1, "agent_start", { agentId: "ns:worker", label: "w", role: "worker", modelId: "m" }),
      runEvent(2, "turn_start", { agentId: "ns:worker", turnIndex: 0 }),
      runEvent(3, "llm_call", llmRecordFor("ns:worker", 1)),
      runEvent(4, "turn_end", { agentId: "ns:worker", turnIndex: 0 })
    ];
    const spans = buildTraceSpans(events as never);
    expect(spans.turns.map((turn) => `${turn.agentId}:${turn.turnIndex}`)).toEqual(["ns:worker:0"]);
    expect(spans.agents.has("ns:worker")).toBe(true);
  });
});
