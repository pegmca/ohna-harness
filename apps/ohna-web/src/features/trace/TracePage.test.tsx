/**
 * W4 TC-W4-04..05 + 投影 + S2/S3/S4 回归。
 */
import type { ConversationDto, LlmCallRecordDto, RunMetaDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TracePage } from "./TracePage";
import { projectTraceRows } from "./trace-projection";

const listConversations = vi.fn();
const listConversationRuns = vi.fn();
const getRunSnapshot = vi.fn();
const replayRunEvents = vi.fn();
const followRunEvents = vi.fn();

vi.mock("../../shared/api/conversation-client", () => ({
  listConversations: (...args: unknown[]) => listConversations(...args),
  getRunSnapshot: (...args: unknown[]) => getRunSnapshot(...args)
}));
vi.mock("../../shared/api/run-stream-client", () => ({
  replayRunEvents: (...args: unknown[]) => replayRunEvents(...args),
  followRunEvents: (...args: unknown[]) => followRunEvents(...args)
}));
vi.mock("./trace-client", () => ({
  listConversationRuns: (...args: unknown[]) => listConversationRuns(...args)
}));

const conversation: ConversationDto = {
  conversationId: "conv-1",
  title: "CLI · session-1",
  status: "active",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  lastMessageAt: "2026-10-20T00:00:00.000Z"
};

const terminalRun: RunMetaDtoV2 = {
  runId: "run-terminal-1",
  requestId: "sess-1:1",
  conversationId: "conv-1",
  modelId: "stub-model",
  mode: "observe",
  source: "cli",
  status: "completed",
  createdAt: "2026-10-20T00:00:01.000Z"
};

const liveRun: RunMetaDtoV2 = {
  ...terminalRun,
  runId: "run-live-2",
  requestId: "sess-1:2",
  status: "running",
  createdAt: "2026-10-20T00:00:02.000Z"
};

const managedRun: RunMetaDtoV2 = {
  ...terminalRun,
  runId: "run-managed-3",
  requestId: "req-3",
  mode: "auto",
  source: "composer",
  status: "completed",
  createdAt: "2026-10-20T00:00:03.000Z"
};

const llmRecord: LlmCallRecordDto = {
  callId: "call-1",
  callIndex: 1,
  startedAt: 1,
  durationMs: 42,
  attemptCount: 1,
  request: {
    provider: "mock",
    api: "openai-completions",
    modelId: "stub-model",
    baseUrl: "http://127.0.0.1/mock",
    messages: [{ role: "user", content: "hi" }],
    providerPayload: { model: "stub-model", stream: true }
  },
  response: {
    status: 200,
    finishReason: "stop",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    message: { role: "assistant", content: [{ type: "text", text: "done" }] }
  }
};

/**
 * 构造 canonical run 事件。
 *
 * @param sequence 序号。
 * @param type 事件类型。
 * @param payload 负载。
 * @returns run 事件 envelope。
 */
function runEvent(sequence: number, type: RunStreamEventDtoV2["type"], payload: unknown): RunStreamEventDtoV2 {
  return {
    eventId: `e-${sequence}`,
    runId: "run-terminal-1",
    requestId: "sess-1:1",
    conversationId: "conv-1",
    sequence,
    type,
    payload,
    createdAt: "2026-10-20T00:00:01.000Z"
  };
}

/** 真实顺序：用户消息先收尾，再发生 LLM 调用，最后是助手消息与终态。 */
function realOrderEvents(): RunStreamEventDtoV2[] {
  return [
    runEvent(1, "message_start", { message: { role: "user", content: "hello" } }),
    runEvent(2, "message_end", { message: { role: "user", content: "hello" } }),
    runEvent(3, "llm_call", llmRecord),
    runEvent(4, "message_start", { message: { role: "assistant", content: [] } }),
    runEvent(5, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    runEvent(6, "run_status", { status: "completed" })
  ];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TracePage", () => {
  it("TC-W4-04: 会话 → run 列表按 runId/status/createdAt/mode/source/requestId 六字段渲染", async () => {
    listConversations.mockResolvedValue({ ok: true, requestId: "r", data: { items: [conversation] } });
    listConversationRuns.mockResolvedValue({
      ok: true,
      requestId: "r",
      data: [managedRun, terminalRun, liveRun]
    });
    replayRunEvents.mockResolvedValue(undefined);
    followRunEvents.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("CLI · session-1")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("run-managed-3")).toBeTruthy());

    const runButtons = screen.getAllByRole("button", { name: /run-(term|live|mana)/ });
    expect(runButtons.length).toBe(3);
    // runId 前 8 位（完整 id 在右侧 header / 侧栏 title）。
    expect(screen.getAllByText("run-term").length).toBeGreaterThan(0);
    expect(screen.getAllByText("run-live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("run-mana").length).toBeGreaterThan(0);
    // status / mode / source / createdAt / requestId 都在列表项里。
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("observe · cli").length).toBeGreaterThan(0);
    expect(screen.getAllByText("auto · composer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-10-20T00:00:01.000Z").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sess-1:1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("req-3").length).toBeGreaterThan(0);
  });

  it("S4-①: 会话 / run 列表请求失败时显示错误态（ok:false 与 reject 两种）", async () => {
    listConversations.mockResolvedValueOnce({
      ok: false,
      requestId: "r",
      error: { code: "internal_error", message: "会话加载失败", requestId: "r" }
    });
    const first = render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("会话加载失败")).toBeTruthy());
    first.unmount();

    listConversations.mockRejectedValueOnce(new Error("network down"));
    render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/加载会话列表失败/)).toBeTruthy());
  });

  it("TC-W4-05: 终态 run 走 replay，事件按真实顺序投影（llm_call 先于助手 message_end）", async () => {
    listConversations.mockResolvedValue({ ok: true, requestId: "r", data: { items: [conversation] } });
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun, liveRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      for (const event of realOrderEvents()) options.onEvent(event);
    });
    followRunEvents.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(replayRunEvents).toHaveBeenCalledWith("run-terminal-1", expect.anything()));
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("done")).toBeTruthy());
    expect(
      screen.getByRole("button", { name: "#1 · stub-model · 42ms · in 3 · out 5 · $0.000000" })
    ).toBeTruthy();
    expect(followRunEvents).not.toHaveBeenCalled();

    // 行序：message(user) → llm → message(assistant) → terminal。
    expect(projectTraceRows(realOrderEvents()).map((row) => row.kind)).toEqual([
      "message",
      "llm",
      "message",
      "terminal"
    ]);
  });

  it("S4-③: 同一 sequence 重复投递只渲染一次", async () => {
    listConversations.mockResolvedValue({ ok: true, requestId: "r", data: { items: [conversation] } });
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      const event = runEvent(2, "message_end", { message: { role: "user", content: "dup" } });
      options.onEvent(event);
      options.onEvent(event);
    });

    render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByText("dup").length).toBe(1));
  });

  it("S2: follow 未收到 run_status 时用快照合成终态条（failed 带错误文案）", async () => {
    listConversations.mockResolvedValue({ ok: true, requestId: "r", data: { items: [conversation] } });
    listConversationRuns
      .mockResolvedValueOnce({ ok: true, requestId: "r", data: [liveRun] })
      .mockResolvedValue({
        ok: true,
        requestId: "r",
        data: [{ ...liveRun, status: "failed" }]
      });
    followRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      // follow 以 agent_end 结束，run_status 被丢弃（真实行为）。
      options.onEvent(runEvent(1, "agent_end", { messages: [] }));
    });
    getRunSnapshot.mockResolvedValue({
      ok: true,
      requestId: "r",
      data: {
        runId: "run-live-2",
        requestId: "sess-1:2",
        conversationId: "conv-1",
        userMessageId: "",
        modelId: "stub-model",
        mode: "observe",
        source: "cli",
        status: "failed",
        lastEventSequence: 3,
        error: { code: "agent_failed", message: "loop 抛出异常", requestId: "sess-1:2" },
        createdAt: "2026-10-20T00:00:02.000Z",
        updatedAt: "2026-10-20T00:00:03.000Z"
      }
    });

    render(
      <MemoryRouter>
        <TracePage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("run failed")).toBeTruthy());
    expect(screen.getByText("loop 抛出异常")).toBeTruthy();
  });
});

describe("projectTraceRows", () => {
  it("合并 message_update 到同一条消息行，工具调用与终态各自成行", () => {
    const rows = projectTraceRows([
      runEvent(1, "message_start", { message: { role: "assistant", content: [] } }),
      runEvent(2, "message_update", {
        message: { role: "assistant", content: [{ type: "text", text: "你" }] },
        assistantMessageEvent: { partial: { role: "assistant", content: [{ type: "text", text: "你" }] } }
      }),
      runEvent(3, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "你好" }] } }),
      runEvent(4, "tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "a" } }),
      runEvent(5, "tool_execution_end", { toolCallId: "t1", toolName: "read", result: { ok: true }, isError: false }),
      runEvent(6, "llm_call", llmRecord),
      runEvent(7, "run_status", { status: "completed" })
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "tool", "llm", "terminal"]);
    const message = rows[0];
    expect(message.kind === "message" && message.text).toBe("你好");
    expect(message.kind === "message" && message.live).toBe(false);
  });

  it("N1/N2: 坏 llm_call 行被跳过；run_status 的 error.message 进入终态行", () => {
    const rows = projectTraceRows([
      runEvent(1, "llm_call", null),
      runEvent(2, "run_status", { status: "failed", error: { message: "loop 抛出异常" } })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("terminal");
    expect(rows[0].kind === "terminal" && rows[0].message).toBe("loop 抛出异常");
  });
});
