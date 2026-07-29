import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentRunResponseDto } from "@aiagent/types";
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
      options?.onAccepted?.({
        runId: "run-accepted",
        requestId: "request-accepted",
        conversationId: "c1",
        modelId: "mock",
        status: "queued",
        eventsUrl: "/events",
        snapshotUrl: "/snapshot"
      });
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
      data: {
        runId: "run-created",
        requestId: "run-request",
        conversationId: "c1",
        modelId: "mock",
        status: "cancelled",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
        events: []
      }
    });
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) =>
      new Promise((_resolve, reject) => {
        createSignal = options?.signal;
        acceptedHook = () => options?.onAccepted?.({
          runId: "run-created",
          requestId: "run-request",
          conversationId: "c1",
          modelId: "mock",
          status: "queued",
          eventsUrl: "/events",
          snapshotUrl: "/snapshot"
        });
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
          await options?.onAccepted?.({
            runId: "run-continues",
            requestId: "request-continues",
            conversationId: "c1",
            modelId: "mock",
            status: "queued",
            eventsUrl: "/events",
            snapshotUrl: "/snapshot"
          });
          resolve({
            ok: true,
            requestId: "terminal",
            data: runResult("run-continues", "c1", "继续执行完成") as AgentRunResponseDto
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
      data: {
        runId: "run-normal",
        requestId: "request-normal",
        conversationId: "c1",
        modelId: "mock",
        status: "cancelled",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
        events: []
      }
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
      await options?.onAccepted?.({
        runId: "run-normal",
        requestId: "request-normal",
        conversationId: "c1",
        modelId: "mock",
        status: "queued",
        eventsUrl: "/events",
        snapshotUrl: "/snapshot"
      });
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

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(runRequests).toHaveLength(2));

    expect(runRequests[1].clientMessageId).not.toBe(runRequests[0].clientMessageId);
    expect(runRequests[1].message).toBe(runRequests[0].message);
    expect(runRequests[1].modelId).toBe(runRequests[0].modelId);
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
            message("user-1", "c1", "历史失败问题"),
            { ...assistantMessage("assistant-1", "c1", "agent_failed", "run-1"), status: "failed", sequence: 2 }
          ]
        });
      }
      if (url === "/api/runs/run-1") {
        const result = {
          ...runResult("run-1", "c1", "agent_failed"),
          modelId: "mock",
          ok: false,
          error: { code: "agent_failed", message: "LLM request timed out." }
        };
        return ok({
          runId: "run-1",
          requestId: result.requestId,
          conversationId: "c1",
          status: "failed",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:01.000Z",
          events: [],
          result
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
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
    modelId: "mock",
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
