import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { describe, expect, it } from "vitest";
import { projectLiveRun, projectRunUserMessages } from "./live-run-projection";

describe("projectLiveRun", () => {
  it("renders streaming text directly from cumulative partial without stitching deltas", () => {
    const events = [
      messageUpdate(1, "text_start", [{ type: "text", text: "" }]),
      messageUpdate(2, "text_delta", [{ type: "text", text: "营收" }]),
      messageUpdate(3, "text_delta", [{ type: "text", text: "营收同比增长" }])
    ];
    const projection = projectLiveRun(events);
    expect(projection.terminal).toBe("running");
    expect(projection.blocks).toEqual([{ type: "text", text: "营收同比增长" }]);
  });

  it("projects thinking and toolCall blocks with tool execution status", () => {
    const events = [
      messageUpdate(1, "thinking_delta", [{ type: "thinking", thinking: "先查指标" }]),
      messageUpdate(2, "toolcall_end", [
        { type: "thinking", thinking: "先查指标" },
        { type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } }
      ]),
      toolExecution(3, "tool_execution_start"),
      toolExecution(4, "tool_execution_end", { result: [{ type: "text", text: "ROE 12%" }], isError: false })
    ];
    const projection = projectLiveRun(events);
    expect(projection.blocks[0]).toEqual({ type: "thinking", thinking: "先查指标", redacted: false });
    const tool = projection.blocks[1];
    expect(tool).toMatchObject({ type: "toolCall", id: "call-1", status: "completed" });
    expect(tool?.type === "toolCall" && tool.result?.content).toEqual([{ type: "text", text: "ROE 12%" }]);
  });

  it("deduplicates replayed sequences and keeps the latest partial", () => {
    const first = messageUpdate(1, "text_delta", [{ type: "text", text: "甲" }]);
    const events = [first, first, messageUpdate(2, "text_delta", [{ type: "text", text: "甲乙" }])];
    expect(projectLiveRun(events).blocks).toEqual([{ type: "text", text: "甲乙" }]);
  });

  it("marks failed tool execution with an error result", () => {
    const events = [
      messageUpdate(1, "toolcall_end", [
        { type: "toolCall", id: "call-1", name: "run_sql", arguments: {} }
      ]),
      toolExecution(2, "tool_execution_end", { result: "boom", isError: true })
    ];
    const projection = projectLiveRun(events);
    const tool = projection.blocks[0];
    expect(tool?.type === "toolCall" && tool.status).toBe("failed");
    expect(tool?.type === "toolCall" && tool.result?.isError).toBe(true);
  });

  it("applies cancelled terminal state from run_error", () => {
    const events = [runError(2, { code: "request_cancelled", message: "cancelled", requestId: "request" })];
    expect(projectLiveRun(events).terminal).toBe("cancelled");
  });

  it("applies failed terminal state from run_error", () => {
    const events = [runError(1, { code: "agent_failed", message: "LLM 超时", requestId: "request" })];
    const projection = projectLiveRun(events);
    expect(projection.terminal).toBe("failed");
    expect(projection.error?.message).toBe("LLM 超时");
  });

  it("settles final blocks from agent_end messages and pairs toolResult", () => {
    const events = [
      messageUpdate(1, "text_delta", [{ type: "text", text: "中间态" }]),
      agentEnd(2, [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "query_metrics", arguments: {} },
            { type: "text", text: "最终回答" }
          ]
        },
        {
          role: "toolResult",
          content: { toolCallId: "call-1", toolName: "query_metrics", content: [{ type: "text", text: "ok" }], isError: false }
        }
      ])
    ];
    const projection = projectLiveRun(events);
    expect(projection.terminal).toBe("completed");
    const tool = projection.blocks[0];
    expect(tool?.type === "toolCall" && tool.status).toBe("completed");
    expect(projection.blocks[1]).toEqual({ type: "text", text: "最终回答" });
  });

  it("keeps blocks from earlier assistant messages in a multi-message run", () => {
    // 真实带工具调用的 run：第一条 assistant 发起 toolCall，第二条流式输出总结。
    const events = [
      envelope(1, "message_start", { message: { role: "assistant", content: [] } }),
      messageUpdate(2, "toolcall_end", [
        { type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } }
      ]),
      toolExecution(3, "tool_execution_start"),
      toolExecution(4, "tool_execution_end", { result: [{ type: "text", text: "ROE 12%" }], isError: false }),
      envelope(5, "message_end", {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } }]
        }
      }),
      envelope(6, "message_start", { message: { role: "assistant", content: [] } }),
      messageUpdate(7, "text_delta", [{ type: "text", text: "ROE 为 12%。" }])
    ];
    // live 中途：第一条消息的工具块不能因为第二条消息的 partial 而消失。
    const live = projectLiveRun(events);
    expect(live.terminal).toBe("running");
    expect(live.blocks.map((block) => block.type)).toEqual(["toolCall", "text"]);
    const liveTool = live.blocks[0];
    expect(liveTool?.type === "toolCall" && liveTool.status).toBe("completed");

    // agent_end 终态：拼接全部 assistant 消息并配对 toolResult，不是只留最后一条。
    const final = projectLiveRun([
      ...events,
      agentEnd(8, [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } }]
        },
        {
          role: "toolResult",
          content: { toolCallId: "call-1", toolName: "query_metrics", content: [{ type: "text", text: "ROE 12%" }], isError: false }
        },
        { role: "assistant", content: [{ type: "text", text: "ROE 为 12%。" }] }
      ])
    ]);
    expect(final.terminal).toBe("completed");
    expect(final.blocks.map((block) => block.type)).toEqual(["toolCall", "text"]);
    const finalTool = final.blocks[0];
    expect(finalTool?.type === "toolCall" && finalTool.result?.content).toEqual([{ type: "text", text: "ROE 12%" }]);
    expect(final.blocks[1]).toEqual({ type: "text", text: "ROE 为 12%。" });
  });

  it("treats agent_end with loop error as failed", () => {
    const projection = projectLiveRun([agentEnd(1, [], { code: "agent_loop_aborted", message: "钩子抛错" })]);
    expect(projection.terminal).toBe("failed");
    expect(projection.error?.code).toBe("agent_loop_aborted");
  });
});

describe("projectRunUserMessages", () => {
  it("projects a web-sourced user_message frame into a timeline user bubble", () => {
    const events = [
      userMessage(1, { messageId: "m-web", content: "在 Web 端发的消息", runId: "run-1", source: "web" })
    ];
    const bubbles = projectRunUserMessages(events);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({
      id: "m-web",
      role: "user",
      content: "在 Web 端发的消息",
      status: "complete",
      runId: "run-1"
    });
  });

  it("projects a cli-sourced user_message frame into a timeline user bubble", () => {
    // 终端 CLI 发起的轮次经总线广播 user_message(source=cli)，Web 也应以用户气泡呈现。
    const events = [
      userMessage(1, { messageId: "m-cli", content: "在终端发的消息", runId: "run-2", source: "cli" })
    ];
    const bubbles = projectRunUserMessages(events);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ id: "m-cli", role: "user", content: "在终端发的消息" });
  });

  it("keeps user bubbles in sequence order and ignores non-user frames", () => {
    const events = [
      userMessage(1, { messageId: "a", content: "第一条", runId: "run-3", source: "web" }),
      messageUpdate(2, "text_delta", [{ type: "text", text: "助手在思考" }]),
      userMessage(3, { messageId: "b", content: "第二条", runId: "run-3", source: "cli" }),
      runStatus(4, "completed")
    ];
    const bubbles = projectRunUserMessages(events);
    expect(bubbles.map((bubble) => bubble.id)).toEqual(["a", "b"]);
  });

  it("deduplicates replayed user_message frames by messageId", () => {
    const frame = userMessage(1, { messageId: "dup", content: "重复帧", runId: "run-4", source: "web" });
    const bubbles = projectRunUserMessages([frame, frame]);
    expect(bubbles).toHaveLength(1);
  });

  it("skips malformed user_message frames missing messageId or content", () => {
    const events = [
      envelope(1, "user_message", { content: "缺 messageId", source: "web", runId: "run-5" }),
      envelope(2, "user_message", { messageId: "only-id", source: "web", runId: "run-5" })
    ];
    expect(projectRunUserMessages(events)).toHaveLength(0);
  });
});


/** @param sequence 序号。 @param kind AssistantMessageEvent 类型。 @param content 累积 partial 内容。 @returns message_update 事件。 */
function messageUpdate(sequence: number, kind: string, content: unknown): RunStreamEventDtoV2 {
  return envelope(sequence, "message_update", {
    message: { role: "assistant", content },
    assistantMessageEvent: { type: kind, contentIndex: 0, partial: { role: "assistant", content } }
  });
}

/** @param sequence 序号。 @param type 工具事件类型。 @param extra 附加 payload。 @returns tool_execution_* 事件。 */
function toolExecution(
  sequence: number,
  type: "tool_execution_start" | "tool_execution_end",
  extra: Record<string, unknown> = {}
): RunStreamEventDtoV2 {
  return envelope(sequence, type, { toolCallId: "call-1", toolName: "query_metrics", args: {}, ...extra });
}

/** @param sequence 序号。 @param error 结构化错误。 @returns run_error 事件。 */
function runError(sequence: number, error: { code: string; message: string; requestId: string }): RunStreamEventDtoV2 {
  return envelope(sequence, "run_error", { error });
}

/** @param sequence 序号。 @param payload user_message 帧 payload。 @returns user_message 事件。 */
function userMessage(
  sequence: number,
  payload: { messageId: string; content: string; runId: string; source: "web" | "cli" }
): RunStreamEventDtoV2 {
  return envelope(sequence, "user_message", payload);
}

/** @param sequence 序号。 @param status run 终态。 @returns run_status 事件。 */
function runStatus(sequence: number, status: string): RunStreamEventDtoV2 {
  return envelope(sequence, "run_status", { status, message: status });
}

/** @param sequence 序号。 @param messages 最终消息。 @param error 可选 loop 错误。 @returns agent_end 事件。 */
function agentEnd(
  sequence: number,
  messages: unknown[],
  error?: { code: string; message: string }
): RunStreamEventDtoV2 {
  return envelope(sequence, "agent_end", { messages, error });
}

/** @param sequence 序号。 @param type 事件类型。 @param payload 事件本体。 @returns canonical envelope。 */
function envelope(sequence: number, type: RunStreamEventDtoV2["type"], payload: unknown): RunStreamEventDtoV2 {
  return {
    eventId: `event-${sequence}`,
    runId: "run",
    requestId: "request",
    conversationId: "conversation",
    sequence,
    type,
    payload,
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}
