/**
 * Trace 投影的 v2.0 形状验收（docs/v2.0/04 §1.1 / §1.3 / §3.1）。
 *
 * 本工作项（W1）只改类型与采集层，web 的编排/可视化在后续工作项。这里锁的是
 * **采集层落进 run 事件后，现有投影不会崩、也不会误读**：
 * - `llm_call` 记录带 `window` / `agentId` / `composition` 时仍投影为一条 llm 行；
 * - 边界事件（agent_start / turn_start / turn_end / agent_end）携带身份字段时不被当成消息行；
 * - `context_event`（v2.0 新增 kind）在投影层安全兜底（后续工作项再给它专属渲染）。
 *
 * W3 追加：每行的 agentId 归属（payload 打标 > llm_call.agentId > supervisor 根节点）、
 * context_event 的独立行、run 级终态恒归 supervisor。
 */
import { describe, expect, it } from "vitest";
import { projectTraceRows, resolveAgentId } from "./trace-projection";
import {
  llmRecord,
  llmRecordFor,
  realOrderEvents,
  runEvent,
  singleAgentEvents,
  teamRunEvents
} from "./trace-fixtures";

describe("trace-projection：v2.0 采集形状", () => {
  it("带 window / agentId / composition 的 llm_call 仍投影为一条 llm 行", () => {
    const rows = projectTraceRows(realOrderEvents());
    const llmRows = rows.filter((row) => row.kind === "llm");
    expect(llmRows).toHaveLength(1);
    const record = llmRows[0].kind === "llm" ? llmRows[0].record : undefined;
    expect(record?.window).toEqual({ contextWindow: 128000, maxTokens: 4096, reserveTokens: 16384 });
    expect(record?.agentId).toBe("supervisor");
    expect(record?.composition?.total).toBe(4);
  });

  it("错误路径记录（无 agentId / composition）同样可投影 —— window 必填仍然在场", () => {
    const errorRecord = {
      ...llmRecord,
      callId: "call-error",
      callIndex: 2,
      response: undefined,
      error: { message: "upstream exploded" },
      agentId: undefined,
      composition: undefined
    };
    const rows = projectTraceRows([runEvent(1, "llm_call", errorRecord)]);
    expect(rows).toHaveLength(1);
    const record = rows[0].kind === "llm" ? rows[0].record : undefined;
    expect(record?.error?.message).toBe("upstream exploded");
    expect(record?.composition).toBeUndefined();
    expect(record?.window.contextWindow).toBe(128000);
  });

  it("携带身份的边界事件不产生消息行；context_event 是 W3 起的独立 context 行", () => {
    const rows = projectTraceRows([
      runEvent(1, "agent_start", {
        type: "agent_start",
        agentId: "supervisor",
        label: "supervisor",
        role: "supervisor",
        modelId: "stub-model"
      }),
      runEvent(2, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
      runEvent(3, "context_event", { kind: "compaction", tokensBefore: 100, tokensAfter: 20 }),
      runEvent(4, "turn_end", {
        type: "turn_end",
        agentId: "supervisor",
        turnIndex: 0,
        message: { role: "assistant", content: [] },
        toolResults: []
      }),
      runEvent(5, "agent_end", { type: "agent_end", agentId: "supervisor", messages: [] })
    ]);
    // 边界事件（agent_*/turn_*）不单列；v2.0 W3 起 context_event 有专属行（不再被静默丢弃）。
    expect(rows.filter((row) => row.kind !== "context")).toHaveLength(0);
    expect(rows.map((row) => row.kind)).toEqual(["context"]);
  });

  it("每行都带 agentId 归属：payload 打标优先，未打标归 supervisor 根节点", () => {
    const rows = projectTraceRows(teamRunEvents());
    const toolRows = rows.filter((row) => row.kind === "tool");
    expect(toolRows.map((row) => row.agentId)).toEqual(["supervisor"]);
    const llmRows = rows.filter((row) => row.kind === "llm");
    expect(llmRows.map((row) => row.agentId)).toEqual(["supervisor", "researcher", "spawn-agent", "supervisor"]);
    const terminal = rows.find((row) => row.kind === "terminal");
    expect(terminal?.agentId).toBe("supervisor");
  });

  it("message_end 的 agentId 来自 payload；缺省（扁平行）归 supervisor", () => {
    const tagged = projectTraceRows(teamRunEvents()).find((row) => row.kind === "message");
    expect(tagged?.agentId).toBe("supervisor");
    const untagged = projectTraceRows([
      runEvent(1, "message_end", { message: { role: "assistant", content: "x" } })
    ]);
    expect(untagged[0].agentId).toBe("supervisor");
  });

  it("context_event 投影为 context 行，携带净回收量与说明", () => {
    const rows = projectTraceRows(singleAgentEvents());
    const contextRow = rows.find((row) => row.kind === "context");
    expect(contextRow).toMatchObject({
      kind: "context",
      eventKind: "compaction",
      before: 62000,
      after: 12000,
      delta: -50000,
      detail: "保留最近 6 轮，摘要 480 字符",
      agentId: "supervisor"
    });
  });

  it("resolveAgentId：空串与非字符串同样归 supervisor", () => {
    expect(resolveAgentId({ agentId: "researcher" })).toBe("researcher");
    expect(resolveAgentId({ agentId: "" })).toBe("supervisor");
    expect(resolveAgentId({ agentId: 42 })).toBe("supervisor");
    expect(resolveAgentId(null)).toBe("supervisor");
    expect(resolveAgentId({ agentId: undefined })).toBe("supervisor");
  });

  it("llm_call 行的归属取 record.agentId（采集层在 streamFn 入口写入）", () => {
    const rows = projectTraceRows([runEvent(1, "llm_call", llmRecordFor("researcher", 1))]);
    expect(rows[0]).toMatchObject({ kind: "llm", agentId: "researcher" });
  });
});
