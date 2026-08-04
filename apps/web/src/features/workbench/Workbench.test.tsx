import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RunSnapshotDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

vi.mock("../../shared/api/run-stream-client", () => ({
  createAndStreamRun: vi.fn(),
  cancelRun: vi.fn()
}));

vi.mock("../../shared/api/composer-client", () => ({
  listModels: vi.fn(async () => ({
    ok: true,
    requestId: "models",
    data: {
      defaultModelId: "mock",
      models: [{
        id: "mock",
        label: "Mock Agent",
        provider: "mock",
        description: "Test model",
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true }
      }]
    }
  })),
  uploadChatAttachment: vi.fn()
}));

const conversations = [
  conversation("c1", "第一会话"),
  conversation("c2", "第二会话")
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Workbench conversation history", () => {
  it("shows a retry action when the model catalog cannot be loaded", async () => {
    const { listModels } = await import("../../shared/api/composer-client");
    vi.mocked(listModels)
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        requestId: "models-retry",
        data: {
          defaultModelId: "mock",
          models: [{
            id: "mock",
            label: "Mock Agent",
            provider: "mock",
            description: "Test model",
            isDefault: true,
            capabilities: { structuredOutput: true, toolCalling: true }
          }]
        }
      });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("模型目录不可用。");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.queryByText("模型目录不可用。")).toBeNull());
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded history when the active conversation is selected again", async () => {
    let historyRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: conversations });
      if (url.includes("/c1/messages")) {
        historyRequests += 1;
        return ok({ items: [userMessage("m1", "c1", "已加载的会话消息")] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已加载的会话消息");
    fireEvent.click(screen.getByRole("button", { name: /^第一会话/ }));

    expect(screen.getByText("已加载的会话消息")).toBeTruthy();
    expect(screen.queryByText("正在加载会话历史…")).toBeNull();
    expect(historyRequests).toBe(1);
  });

  it("restores a persisted assistant answer with a folded process before the final answer", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversations[0]] });
      if (url.includes("/c1/messages")) {
        return ok({ items: [assistantMessage("m1", "c1", "最终研究结论", "r1")] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    const processLabel = await screen.findByText("已完成");
    const process = processLabel.closest("summary")!;
    const answer = screen.getByText("最终研究结论");

    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制回答" }));
    expect(writeText).toHaveBeenCalledWith("最终研究结论");
    expect(screen.getByRole("button", { name: "重新生成回答" })).toBeTruthy();
    fireEvent.click(process);
    fireEvent.click(screen.getByRole("button", { name: "查看开发者详情" }));
    expect(await screen.findByRole("heading", { level: 2, name: "回答过程" })).toBeTruthy();
    const developerDetails = screen.getByText("开发者详情").closest("details");
    expect(developerDetails?.open).toBe(false);
  });

  it("renders thinking and toolCall blocks with paired toolResult, plus a compaction divider", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversations[0]] });
      if (url.includes("/c1/messages")) {
        return ok({
          items: [
            userMessage("u1", "c1", "查一下 ROE"),
            {
              ...assistantMessage("a1", "c1", "ROE 为 12%。", "r1"),
              content: [
                { type: "thinking", thinking: "需要先取净利润" },
                { type: "toolCall", id: "call-1", name: "query_metrics", arguments: { ticker: "000001.SZ" } },
                { type: "text", text: "ROE 为 12%。" }
              ]
            },
            toolResultMessage("t1", "c1"),
            compactionMessage("x1", "c1")
          ]
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("ROE 为 12%。");
    // thinking 与 toolCall 默认折叠。
    const thinkingSummary = screen.getByText("思考过程").closest("details")!;
    expect(thinkingSummary.open).toBe(false);
    const toolDetails = screen.getByText("query_metrics").closest("details")!;
    expect(toolDetails.open).toBe(false);
    // 展开 toolCall 可见参数与配对结果。
    fireEvent.click(screen.getByText("query_metrics"));
    expect(toolDetails.open).toBe(true);
    expect(screen.getByText(/"ticker": "000001.SZ"/)).toBeTruthy();
    expect(screen.getByText("净利润 100 亿")).toBeTruthy();
    expect(screen.getByText("历史已压缩")).toBeTruthy();
  });

  it("restores URL selection and ignores an aborted previous conversation response", async () => {
    const pendingFirst = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: conversations });
      if (url.includes("/c1/messages")) {
        init?.signal?.addEventListener("abort", () => pendingFirst.reject(new DOMException("Aborted", "AbortError")));
        return pendingFirst.promise;
      }
      if (url.includes("/c2/messages")) return ok({ items: [userMessage("m2", "c2", "第二会话消息")] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "第一会话" });
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => {
      pendingFirst.resolve(ok({ items: [userMessage("m1", "c1", "不应串写")] }));
    });
    expect(screen.queryByText("不应串写")).toBeNull();
  });

  it("renders empty/error states and appends conversation pagination", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) {
        attempts += 1;
        if (attempts === 1) return failure("internal_error", "暂时失败");
        if (url.includes("cursor=next")) return ok({ items: [conversation("c2", "更多会话")] });
        return ok({ items: [conversation("c1", "首个会话")], nextCursor: "next" });
      }
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    expect(await screen.findByText(/暂时失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "首个会话" })).toBeTruthy();
    expect(await screen.findByText("从一个金融研究问题开始")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("更多会话")).toBeTruthy();
  });

  it("continues conversation pagination until the URL-selected conversation is found", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/conversations?limit=30") {
        return ok({ items: [conversation("c1", "首屏会话")], nextCursor: "next" });
      }
      if (url.includes("cursor=next")) {
        return ok({ items: [conversation("target", "深页会话")] });
      }
      if (url.includes("/target/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=target"]}><Workbench /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "深页会话" })).toBeTruthy();
    expect(requestedUrls.some((url) => url.includes("cursor=next"))).toBe(true);
  });

  it("does not append a delayed message page after switching conversations", async () => {
    const delayedPage = deferred<Response>();
    let c1Requests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: conversations });
      if (url.includes("/c1/messages")) {
        c1Requests += 1;
        if (c1Requests === 1) return ok({ items: [userMessage("m1", "c1", "首条消息")], nextCursor: "more" });
        init?.signal?.addEventListener("abort", () => delayedPage.reject(new DOMException("Aborted", "AbortError")));
        return delayedPage.promise;
      }
      if (url.includes("/c2/messages")) return ok({ items: [userMessage("m2", "c2", "第二会话消息")] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("首条消息");
    fireEvent.click(screen.getByRole("button", { name: "加载更多消息" }));
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => delayedPage.resolve(ok({ items: [userMessage("late", "c1", "迟到分页消息")] })));
    expect(screen.queryByText("迟到分页消息")).toBeNull();
  });

  it("skips the known-empty initial history so a newly persisted user message cannot duplicate live state", async () => {
    let historyRequests = 0;
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockResolvedValue({
      ok: false,
      requestId: "run_failed",
      error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/conversations?limit=30") return ok({ items: [] });
      if (url === "/api/conversations") return ok(conversation("created", "首次问题"));
      if (url.includes("/created/messages")) {
        historyRequests += 1;
        return ok({ items: [userMessage("persisted", "created", "首次问题")] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { container } = render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("暂无历史会话，创建一个开始研究。");
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "首次问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await screen.findByText("首次问题");
    await waitFor(() => expect(createAndStreamRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((textbox as HTMLTextAreaElement).disabled).toBe(false));
    expect((textbox as HTMLTextAreaElement).value).toBe("首次问题");
    expect(historyRequests).toBe(0);
    expect(container.querySelector(".message-text")?.textContent).toBe("首次问题");
    expect([...container.querySelectorAll(".message-text")]
      .filter((element) => element.textContent === "首次问题")).toHaveLength(1);
  });

  it("clears the submitted input only after the server accepts the Run", async () => {
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      options?.onAccepted?.(accepted("run-accepted"));
      return {
        ok: false,
        requestId: "stream_failed",
        error: { code: "internal_error", message: "stream failed", requestId: "stream_failed" }
      };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "已接受问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe(""));
  });

  it("cancels a server-created Run when stop was requested before its delayed accepted response", async () => {
    const { cancelRun, createAndStreamRun } = await import("../../shared/api/run-stream-client");
    let acceptedHook: (() => void | Promise<void>) | undefined;
    let createSignal: AbortSignal | undefined;
    vi.mocked(cancelRun).mockResolvedValue({
      ok: true,
      requestId: "cancel-request",
      data: snapshot("run-created", "cancelled")
    });
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) =>
      new Promise((_resolve, reject) => {
        createSignal = options?.signal;
        acceptedHook = () => options?.onAccepted?.(accepted("run-created"));
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "尚未接受的问题" } });
    fireEvent.submit(textbox.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
    expect(createSignal?.aborted).toBe(false);
    expect(screen.getByText(/正在等待服务端确认任务/)).toBeTruthy();
    await act(async () => acceptedHook?.());
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith("run-created"));
    await waitFor(() => expect(textbox.disabled).toBe(false));
    expect(textbox.value).toBe("尚未接受的问题");
    expect(screen.getByText("已停止服务端任务，输入和附件草稿已保留。")).toBeTruthy();
  });

  it("clears the submitted draft and completes the Run when pre-accepted cancellation fails", async () => {
    const { cancelRun, createAndStreamRun } = await import("../../shared/api/run-stream-client");
    let finishAcceptedRun: (() => Promise<void>) | undefined;
    vi.mocked(cancelRun).mockResolvedValue({
      ok: false,
      requestId: "cancel-failed",
      error: { code: "internal_error", message: "取消服务暂不可用", requestId: "cancel-failed" }
    });
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) =>
      new Promise((resolve) => {
        finishAcceptedRun = async () => {
          await options?.onAccepted?.(accepted("run-continues"));
          options?.onEvent?.(textEvent(1, "继续执行完成"));
          resolve({
            ok: true,
            requestId: "terminal",
            data: { status: "completed", requestId: "terminal" }
          });
        };
      }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "取消失败仍执行" } });
    fireEvent.submit(textbox.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
    await act(async () => finishAcceptedRun?.());

    await screen.findByText("继续执行完成");
    expect(textbox.value).toBe("");
    expect(screen.getByText(/取消服务暂不可用/)).toBeTruthy();
  });

  it("uses a new clientMessageId when the same text is retried after an accepted Run is stopped", async () => {
    const runRequests: Array<{ clientMessageId?: string }> = [];
    const { cancelRun, createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(cancelRun).mockResolvedValue({
      ok: true,
      requestId: "cancel-normal",
      data: snapshot("run-normal", "cancelled")
    });
    vi.mocked(createAndStreamRun).mockImplementation(async (request, options) => {
      runRequests.push(request);
      if (runRequests.length > 1) {
        return {
          ok: false,
          requestId: "retry-failed",
          error: { code: "internal_error", message: "test complete", requestId: "retry-failed" }
        };
      }
      await options?.onAccepted?.(accepted("run-normal"));
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "停止后重试" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(textbox.value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    await waitFor(() => expect(textbox.disabled).toBe(false));

    fireEvent.change(textbox, { target: { value: "停止后重试" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(2));
    expect(runRequests[1].clientMessageId).not.toBe(runRequests[0].clientMessageId);
  });

  it("reuses the same clientMessageId when the user retries an identical failed submission", async () => {
    const runRequests: Array<{ clientMessageId?: string }> = [];
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (request) => {
      runRequests.push(request);
      return {
        ok: false,
        requestId: "run_failed",
        error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
      };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const { container } = render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "同一问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(1));
    fireEvent.change(textbox, { target: { value: "同一问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(2));
    expect(runRequests[1].clientMessageId).toBe(runRequests[0].clientMessageId);
    expect([...container.querySelectorAll(".message-text")]
      .filter((element) => element.textContent === "同一问题")).toHaveLength(1);
  });

  it("creates a new Run with the original model when a failed message retry is clicked", async () => {
    const runRequests: Array<{ clientMessageId?: string; message: string; modelId?: string }> = [];
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (request) => {
      runRequests.push(request);
      return {
        ok: false,
        requestId: `run_failed_${runRequests.length}`,
        error: {
          code: "agent_failed",
          message: "LLM request timed out.",
          requestId: `run_failed_${runRequests.length}`
        }
      };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "解释 ROE" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: "重新生成回答" }));
    await waitFor(() => expect(runRequests).toHaveLength(2));

    expect(runRequests[1].clientMessageId).not.toBe(runRequests[0].clientMessageId);
    expect(runRequests[1].message).toBe(runRequests[0].message);
    expect(runRequests[1].modelId).toBe(runRequests[0].modelId);
  });

  it("keeps the toolCall message and the summary message of a multi-message run", async () => {
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-multi"));
      options?.onEvent?.(streamEvent(1, "message_start", { message: { role: "assistant", content: [] } }));
      options?.onEvent?.(streamEvent(2, "message_update", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: {} }] },
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: {} }] }
        }
      }));
      options?.onEvent?.(streamEvent(3, "tool_execution_end", {
        toolCallId: "call-1",
        toolName: "query_metrics",
        result: [{ type: "text", text: "ROE 12%" }],
        isError: false
      }));
      options?.onEvent?.(streamEvent(4, "message_end", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: {} }] }
      }));
      options?.onEvent?.(streamEvent(5, "message_start", { message: { role: "assistant", content: [] } }));
      options?.onEvent?.(streamEvent(6, "message_update", {
        message: { role: "assistant", content: [{ type: "text", text: "最终总结回答" }] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          partial: { role: "assistant", content: [{ type: "text", text: "最终总结回答" }] }
        }
      }));
      options?.onEvent?.(streamEvent(7, "agent_end", {
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "query_metrics", arguments: {} }] },
          { role: "toolResult", content: { toolCallId: "call-1", toolName: "query_metrics", content: [{ type: "text", text: "ROE 12%" }], isError: false } },
          { role: "assistant", content: [{ type: "text", text: "最终总结回答" }] }
        ]
      }));
      return { ok: true, requestId: "terminal", data: { status: "completed", requestId: "terminal" } };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/messages")) return ok({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "多消息 run" } });
    fireEvent.submit(textbox.closest("form")!);

    // 终态渲染里两条 assistant 消息的块都在：工具调用块 + 总结正文。
    await screen.findByText("最终总结回答");
    expect(screen.getByText("query_metrics")).toBeTruthy();
    fireEvent.click(screen.getByText("query_metrics"));
    expect(screen.getByText("ROE 12%")).toBeTruthy();
  });

  it("shows retry for a failed message restored from conversation history", async () => {
    const runRequests: Array<{ message: string; modelId?: string }> = [];
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (request) => {
      runRequests.push(request);
      return failureResult("agent_failed", "still unavailable");
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversation("c1", "已有会话")] });
      if (url.includes("/c1/messages")) {
        return ok({
          items: [
            userMessage("user-1", "c1", "历史失败问题"),
            { ...assistantMessage("assistant-1", "c1", "agent_failed", "run-1"), stopReason: "error", sequence: 2 }
          ]
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "重新生成回答" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]).toMatchObject({ message: "历史失败问题", modelId: "mock" });
  });
});

function conversation(conversationId: string, title: string) {
  return {
    conversationId,
    title,
    status: "active",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    lastMessageAt: "2026-07-25T00:00:00.000Z"
  };
}

/** 新协议 LinearMessageDto：user content 为纯文本，无 status 字段。 */
function userMessage(messageId: string, conversationId: string, content: string) {
  return {
    messageId,
    conversationId,
    role: "user",
    content,
    messageType: "normal",
    sequence: 1,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

/** assistant content 为 pi 块数组。 */
function assistantMessage(messageId: string, conversationId: string, text: string, runId: string) {
  return {
    ...userMessage(messageId, conversationId, ""),
    runId,
    role: "assistant",
    content: [{ type: "text", text }],
    modelId: "mock",
    stopReason: "stop"
  };
}

/** toolResult 行：渲染时并入前一条 assistant 消息的 toolCall 块。 */
function toolResultMessage(messageId: string, conversationId: string) {
  return {
    ...userMessage(messageId, conversationId, ""),
    role: "toolResult",
    content: {
      toolCallId: "call-1",
      toolName: "query_metrics",
      content: [{ type: "text", text: "净利润 100 亿" }],
      isError: false
    },
    sequence: 3
  };
}

/** compaction 行：渲染为「历史已压缩」分隔条。 */
function compactionMessage(messageId: string, conversationId: string) {
  return {
    ...userMessage(messageId, conversationId, "[compaction] 更早历史已压缩"),
    messageType: "compaction",
    sequence: 4
  };
}

/** @param runId Run ID。 @param status 终态。 @returns 新协议 Run 快照。 */
function snapshot(runId: string, status: RunSnapshotDtoV2["status"]): RunSnapshotDtoV2 {
  return {
    runId,
    requestId: `request_${runId}`,
    conversationId: "c1",
    modelId: "mock",
    mode: "auto",
    source: "composer",
    status,
    lastEventSequence: 0,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:01.000Z"
  };
}

/** @param runId Run ID。 @returns Run accepted DTO。 */
function accepted(runId: string) {
  return {
    runId,
    requestId: `request_${runId}`,
    conversationId: "c1",
    modelId: "mock",
    status: "queued" as const,
    eventsUrl: "/events",
    snapshotUrl: "/snapshot"
  };
}

/** @param sequence 序号。 @param text 累积文本。 @returns message_update 事件。 */
function textEvent(sequence: number, text: string): RunStreamEventDtoV2 {
  return {
    eventId: `event-${sequence}`,
    runId: "run",
    requestId: "request",
    conversationId: "c1",
    sequence,
    type: "message_update",
    payload: {
      message: { role: "assistant", content: [{ type: "text", text }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text }] } }
    },
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

/** @param sequence 序号。 @param type 事件类型。 @param payload 事件本体。 @returns canonical envelope。 */
function streamEvent(sequence: number, type: RunStreamEventDtoV2["type"], payload: unknown): RunStreamEventDtoV2 {
  return {
    eventId: `event-${sequence}`,
    runId: "run",
    requestId: "request",
    conversationId: "c1",
    sequence,
    type,
    payload,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function failureResult(code: "agent_failed", messageText: string) {
  return {
    ok: false as const,
    requestId: "request_failed",
    error: { code, message: messageText, requestId: "request_failed" }
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, requestId: "test", data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function failure(code: string, messageText: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    requestId: "test",
    error: { code, message: messageText, requestId: "test" }
  }), { status: 500, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
