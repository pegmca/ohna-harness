/**
 * TC-L2-02 · `TraceDrawer` 渲染回归（承接原 TracePage 的 UI 断言）。
 *
 * 覆盖：run 列表六字段语义（status / mode / source / 相对时间 + title 全 id）、事件行、
 * `LlmCallBlock` 一等公民（LLM 调用可展开）、空态文案、收起时不渲染、错误态。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceDrawer } from "./TraceDrawer";
import {
  llmRecord,
  liveRun,
  realOrderEvents,
  runEvent,
  terminalRun
} from "./trace-fixtures";

const listConversationRuns = vi.fn();
const getRunSnapshot = vi.fn();
const replayRunEvents = vi.fn();
const followRunEvents = vi.fn();

vi.mock("../../shared/api/conversation-client", () => ({
  getRunSnapshot: (...args: unknown[]) => getRunSnapshot(...args)
}));
vi.mock("../../shared/api/run-stream-client", () => ({
  replayRunEvents: (...args: unknown[]) => replayRunEvents(...args),
  followRunEvents: (...args: unknown[]) => followRunEvents(...args)
}));
vi.mock("./trace-client", () => ({
  listConversationRuns: (...args: unknown[]) => listConversationRuns(...args)
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * 渲染展开态抽屉。
 *
 * @param props.conversationId 会话 ID。
 * @returns 渲染结果。
 */
function renderDrawer(props: { conversationId?: string } = {}) {
  return render(
    <TraceDrawer
      conversationId={props.conversationId ?? "conv-1"}
      conversationTitle="CLI · session-1"
      isOpen
      onClose={vi.fn()}
    />
  );
}

describe("TraceDrawer", () => {
  it("TC-L2-02: 抽屉标题跟随会话，run 选择条展示状态与相对时间", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun, liveRun] });
    replayRunEvents.mockResolvedValue(undefined);
    followRunEvents.mockResolvedValue(undefined);

    renderDrawer();
    expect(screen.getByRole("heading", { level: 2, name: "CLI · session-1" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("list", { name: "Run 列表" })).toBeTruthy());

    const chips = screen.getAllByRole("listitem");
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute("title")).toBe("run-terminal-1");
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    expect(chips[0].textContent).toContain("completed");
    expect(chips[1].textContent).toContain("running");
    // 选中 run 的 mode / source / modelId / requestId 摘要行。
    expect(screen.getByText("observe")).toBeTruthy();
    expect(screen.getByText("CLI")).toBeTruthy();
    expect(screen.getByText("model: stub-model")).toBeTruthy();
    expect(screen.getByText("requestId: sess-1:1")).toBeTruthy();
  });

  it("TC-L2-02: 事件行渲染且 llm_call 作为一等公民可展开", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: ReturnType<typeof runEvent>) => void }) => {
      for (const event of realOrderEvents()) options.onEvent(event);
    });

    renderDrawer();
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("done")).toBeTruthy());
    // LLM 采集行：调用序号 / 模型 / 耗时 / token 摘要，可展开查看请求与响应。
    const llmSummary = screen.getByRole("button", { name: "#1 · stub-model · 42ms · in 3 · out 5 · $0.000000" });
    expect(llmSummary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(llmSummary);
    expect(llmSummary.getAttribute("aria-expanded")).toBe("true");
    // 展开后默认停在「请求参数 → Provider Payload」，可见真实发出的 payload。
    await waitFor(() => expect(screen.getByRole("tab", { name: "Provider Payload" }).getAttribute("aria-selected")).toBe("true"));
    // payload JSON 里包含真实请求模型名（同一文本可能出现多处，取集合断言）。
    expect(screen.getAllByText(/stub-model/).length).toBeGreaterThan(0);
    // 切到「响应」可见 finishReason / usage。
    fireEvent.click(screen.getByRole("tab", { name: "响应" }));
    expect(await screen.findByText(/finishReason: stop/)).toBeTruthy();
    expect(llmRecord.request.modelId).toBe("stub-model");
  });

  it("TC-L2-02: 会话无 run 时展示空态文案", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [] });
    renderDrawer();
    expect(await screen.findByText("本会话还没有运行记录。")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Run 列表" })).toBeNull();
  });

  it("未选择会话时提示先选会话，且不发请求", async () => {
    render(
      <TraceDrawer conversationId={undefined} conversationTitle="未选择会话" isOpen onClose={vi.fn()} />
    );
    expect(screen.getByText(/尚未选择会话/)).toBeTruthy();
    expect(listConversationRuns).not.toHaveBeenCalled();
  });

  it("run 列表加载失败时展示结构化错误", async () => {
    listConversationRuns.mockResolvedValue({
      ok: false,
      requestId: "r",
      error: { code: "internal_error", message: "run 列表不可用", requestId: "r" }
    });
    renderDrawer();
    expect(await screen.findByText("run 列表不可用")).toBeTruthy();
  });

  it("收起（isOpen=false）时不渲染面板、不发请求", () => {
    const { container } = render(
      <TraceDrawer conversationId="conv-1" conversationTitle="CLI · session-1" isOpen={false} onClose={vi.fn()} />
    );
    expect(container.querySelector(".trace-drawer")).toBeNull();
    expect(listConversationRuns).not.toHaveBeenCalled();
  });

  it("收起按钮回调 onClose", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [] });
    const onClose = vi.fn();
    render(<TraceDrawer conversationId="conv-1" conversationTitle="CLI · session-1" isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "收起 Trace" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("终态兜底：follow 以 agent_end 结束时仍展示终态横条", async () => {
    listConversationRuns
      .mockResolvedValueOnce({ ok: true, requestId: "r", data: [liveRun] })
      .mockResolvedValue({ ok: true, requestId: "r", data: [{ ...liveRun, status: "failed" }] });
    followRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: ReturnType<typeof runEvent>) => void }) => {
      options.onEvent(runEvent(1, "agent_end", { messages: [] }, "run-live-2"));
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

    renderDrawer();
    expect(await screen.findByText("run failed")).toBeTruthy();
    expect(screen.getByText("loop 抛出异常")).toBeTruthy();
  });
});
