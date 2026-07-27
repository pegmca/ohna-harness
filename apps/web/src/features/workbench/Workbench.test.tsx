import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

vi.mock("../../shared/api/run-stream-client", () => ({
  createAndStreamRun: vi.fn()
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
  it("keeps loaded history when the active conversation is selected again", async () => {
    let historyRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: conversations });
      if (url.includes("/c1/messages")) {
        historyRequests += 1;
        return ok({ items: [message("m1", "c1", "已加载的会话消息")] });
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

  it("restores a persisted run and renders its process before the final answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/conversations?")) return ok({ items: [conversations[0]] });
      if (url.includes("/c1/messages")) {
        return ok({ items: [assistantMessage("m1", "c1", "最终研究结论", "r1")] });
      }
      if (url === "/api/runs/r1") {
        const result = runResult("r1", "c1", "最终研究结论");
        return ok({
          runId: "r1",
          requestId: result.requestId,
          conversationId: "c1",
          status: "succeeded",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:01.000Z",
          events: [],
          result
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    const process = await screen.findByRole("button", { name: /运行摘要/ });
    const answer = screen.getByText("最终研究结论");

    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Steps/ }));
    expect(await screen.findByRole("heading", { name: "Agent Steps" })).toBeTruthy();
    expect(screen.queryByText("Trace summary")).toBeNull();
    expect(screen.queryByText("Tool calls")).toBeNull();
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
      if (url.includes("/c2/messages")) return ok({ items: [message("m2", "c2", "第二会话消息")] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "第一会话" });
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => {
      pendingFirst.resolve(ok({ items: [message("m1", "c1", "不应串写")] }));
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
        if (c1Requests === 1) return ok({ items: [message("m1", "c1", "首条消息")], nextCursor: "more" });
        init?.signal?.addEventListener("abort", () => delayedPage.reject(new DOMException("Aborted", "AbortError")));
        return delayedPage.promise;
      }
      if (url.includes("/c2/messages")) return ok({ items: [message("m2", "c2", "第二会话消息")] });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("首条消息");
    fireEvent.click(screen.getByRole("button", { name: "加载更多消息" }));
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => delayedPage.resolve(ok({ items: [message("late", "c1", "迟到分页消息")] })));
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
        return ok({ items: [message("persisted", "created", "首次问题")] });
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
    expect(historyRequests).toBe(0);
    expect(container.querySelector(".message-text")?.textContent).toBe("首次问题");
    expect([...container.querySelectorAll(".message-text")]
      .filter((element) => element.textContent === "首次问题")).toHaveLength(1);
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

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "同一问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(1));
    fireEvent.change(textbox, { target: { value: "同一问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(2));
    expect(runRequests[1].clientMessageId).toBe(runRequests[0].clientMessageId);
    expect(screen.getAllByText("同一问题")).toHaveLength(1);
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

function message(messageId: string, conversationId: string, content: string) {
  return {
    messageId,
    conversationId,
    role: "user",
    content,
    status: "completed",
    sequence: 1,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function assistantMessage(messageId: string, conversationId: string, content: string, runId: string) {
  return {
    ...message(messageId, conversationId, content),
    runId,
    role: "assistant"
  };
}

function runResult(runId: string, conversationId: string, answer: string) {
  return {
    runId,
    conversationId,
    requestId: `request_${runId}`,
    traceId: `trace_${runId}`,
    ok: true,
    intent: "chat",
    answer,
    steps: [],
    trace: {
      traceId: `trace_${runId}`,
      requestId: `request_${runId}`,
      startedAt: "2026-07-25T00:00:00.000Z",
      completedAt: "2026-07-25T00:00:01.000Z",
      summary: {
        status: "succeeded",
        durationMs: 1000,
        modelCallCount: 1,
        toolCallCount: 0,
        retrievalCount: 0,
        inputTokens: 10,
        outputTokens: 20,
        knownTokenTotal: 30,
        unknownTokenCallCount: 0,
        errorCount: 0
      },
      events: []
    },
    tracePersistence: { status: "complete" }
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
