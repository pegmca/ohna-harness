import type { AgentRunStreamEventDto, TraceEventDto } from "@aiagent/types";
import { describe, expect, it } from "vitest";
import { projectLiveRun, projectRunActivity } from "./live-run-projection";

describe("projectLiveRun", () => {
  it("keeps first appearance order and reactivates an interleaved category", () => {
    const events = [
      trace(1, "request_received"),
      trace(2, "model_call"),
      trace(3, "tool_call"),
      trace(4, "model_call")
    ];
    expect(projectLiveRun(events).map(({ category, status, count }) => ({ category, status, count }))).toEqual([
      { category: "routing", status: "completed", count: 1 },
      { category: "model", status: "active", count: 2 },
      { category: "tools", status: "completed", count: 1 }
    ]);
  });

  it("deduplicates replay and applies cancelled terminal state", () => {
    const routing = trace(1, "request_received");
    const events = [routing, routing, trace(2, "model_call"), cancelled(3)];
    expect(projectLiveRun(events).map(({ category, status, count }) => ({ category, status, count }))).toEqual([
      { category: "routing", status: "completed", count: 1 },
      { category: "model", status: "cancelled", count: 1 }
    ]);
  });

  it("routes unknown future trace events to finalizing", () => {
    expect(projectLiveRun([trace(1, "future_event")])[0]?.category).toBe("finalizing");
  });

  it("projects terminal trace into user-facing Chinese activity categories", () => {
    const events = [
      terminalTrace("request_received"),
      terminalTrace("retrieval", { ok: true }),
      terminalTrace("tool_call", { ok: false }),
      terminalTrace("final_response")
    ];
    expect(projectRunActivity(events).map(({ label, status }) => ({ label, status }))).toEqual([
      { label: "理解问题", status: "completed" },
      { label: "检索资料", status: "completed" },
      { label: "查询数据", status: "failed" },
      { label: "整理结果", status: "completed" }
    ]);
  });
});

/** @param sequence canonical sequence。 @param type Trace type。 @returns 测试事件。 */
function trace(sequence: number, type: string): AgentRunStreamEventDto {
  return {
    type: "trace_event",
    eventId: `event-${sequence}`,
    sequence,
    runId: "run",
    requestId: "request",
    conversationId: "conversation",
    traceId: "trace",
    createdAt: "2026-07-28T00:00:00.000Z",
    event: {
      type,
      id: `trace-${sequence}`,
      traceId: "trace",
      requestId: "request",
      createdAt: "2026-07-28T00:00:00.000Z"
    }
  } as AgentRunStreamEventDto;
}

/** @param sequence canonical sequence。 @returns 取消终态事件。 */
function cancelled(sequence: number): AgentRunStreamEventDto {
  return {
    type: "run_error",
    eventId: `event-${sequence}`,
    sequence,
    runId: "run",
    requestId: "request",
    conversationId: "conversation",
    traceId: "trace",
    createdAt: "2026-07-28T00:00:00.000Z",
    error: { code: "request_cancelled", message: "cancelled", requestId: "request" }
  };
}

/**
 * 创建只包含投影所需字段的终态 Trace 测试事件。
 *
 * @param type Trace 类型。
 * @param extra 用于表达成功或失败的附加字段。
 * @returns Trace 测试事件。
 */
function terminalTrace(type: string, extra: Record<string, unknown> = {}): TraceEventDto {
  return {
    type,
    id: `trace-${type}`,
    traceId: "trace",
    requestId: "request",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...extra
  } as TraceEventDto;
}
