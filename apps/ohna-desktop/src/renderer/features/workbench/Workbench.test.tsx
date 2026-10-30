import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RunSnapshotDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

vi.mock("../../shared/sdk/ohna-client");

/**
 * 配置一个已授权工作区：桌面端创建会话必须绑定真实工作区。
 *
 * @param client 已 mock 的渲染端 SDK 封装。
 * @returns 工作区描述符。
 */
function stubWorkspace(client: typeof import("../../shared/sdk/ohna-client")) {
  const workspace = {
    workspaceId: "ws-test",
    displayPath: "/tmp/ohna-test",
    status: "authorized" as const
  };
  vi.mocked(client.listWorkspaces).mockResolvedValue({
    ok: true,
    requestId: "workspaces.list",
    data: [workspace]
  });
  return workspace;
}
// 默认模型目录：绝大多数用例只依赖「目录已就绪」。在 beforeEach 重挂，覆盖前序用例残留的
// 覆盖（如 catalog 重试用例的 mockRejectedValueOnce），保证每个用例起始都有可用目录；
// 需要模拟目录失败的用例用 mockRejectedValueOnce 在自身内叠加即可。
beforeEach(async () => {
  const { listModels } = await import("../../shared/sdk/ohna-client");
  vi.mocked(listModels).mockResolvedValue({
    ok: true,
    requestId: "models-default",
    data: {
      defaultModelId: "mock",
      models: [{
        id: "mock",
        label: "Mock Agent",
        provider: "mock",
        description: "Test model",
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true },
        contextWindow: 128_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }]
    }
  });
});

afterEach(() => {
  cleanup();
  // 每个用例自设关心的 SDK mock；resetAllMocks 在用例间清空实现与调用计数，避免前序用例的
  // mockImplementation 泄漏到后续用例（listModels 等默认实现由 beforeEach 在下一个用例重挂）。
  vi.resetAllMocks();
});

describe("Workbench conversation history", () => {
  it("shows a retry action when the model catalog cannot be loaded", async () => {
    const { listModels } = await import("../../shared/sdk/ohna-client");
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
            capabilities: { structuredOutput: true, toolCalling: true },
            // v2.0（docs/v2.0/04 §5.6）：模型目录新增成本计量字段，mock 值按 0 下发。
            contextWindow: 128_000,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }]
        }
      });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("模型目录不可用。");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.queryByText("模型目录不可用。")).toBeNull());
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded history when the active conversation is selected again", async () => {
    let historyRequests = 0;
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: conversations, nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockImplementation(async (id) => {
      historyRequests += 1;
      return { ok: true, requestId: "m", data: { items: [userMessage("m1", "c1", "已加载的会话消息")], nextCursor: null } };
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已加载的会话消息");
    fireEvent.click(screen.getByRole("button", { name: /^第一会话/ }));

    expect(screen.getByText("已加载的会话消息")).toBeTruthy();
    expect(screen.queryByText("正在加载会话历史…")).toBeNull();
    expect(historyRequests).toBe(1);
  });

  it("restores a persisted assistant answer with a run status summary before the final answer", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversations[0]], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [assistantMessage("m1", "c1", "最终研究结论", "r1")], nextCursor: null } });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    const processLabel = await screen.findByText("已完成");
    const process = processLabel.closest(".run-process")!;
    const answer = screen.getByText("最终研究结论");

    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看开发者详情" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制回答" }));
    expect(writeText).toHaveBeenCalledWith("最终研究结论");
    expect(screen.getByRole("button", { name: "重新生成回答" })).toBeTruthy();
  });

  it("renders thinking and toolCall blocks with paired toolResult, plus a compaction divider", async () => {
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversations[0]], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [
      userMessage("u1", "c1", "查一下类型错误"),
      { ...assistantMessage("a1", "c1", "类型错误已修复。", "r1"), content: [ { type: "thinking", thinking: "需要先读文件" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }, { type: "text", text: "类型错误已修复。" } ] },
      toolResultMessage("t1", "c1"),
      compactionMessage("x1", "c1")
    ], nextCursor: null } });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("类型错误已修复。");
    // thinking 与 toolCall 默认折叠。
    const thinkingSummary = screen.getByText("思考过程").closest("details")!;
    expect(thinkingSummary.open).toBe(false);
    const toolDetails = screen.getByText("read").closest("details")!;
    expect(toolDetails.open).toBe(false);
    // 展开 toolCall 可见参数与配对结果。
    fireEvent.click(screen.getByText("read"));
    expect(toolDetails.open).toBe(true);
    // BUG-003 后工具参数走 JsonViewer 树：展开「调用参数」折叠块后断言 path 键与其值各自渲染。
    fireEvent.click(within(toolDetails).getByText("调用参数"));
    expect(within(toolDetails).getByText("path")).toBeTruthy();
    expect(within(toolDetails).getByText('"src/index.ts"')).toBeTruthy();
    expect(screen.getByText("文件内容已返回")).toBeTruthy();
    expect(screen.getByText("历史已压缩")).toBeTruthy();
  });

  it("restores URL selection and ignores an aborted previous conversation response", async () => {
    const pendingFirst = deferred<Response>();
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: conversations, nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockImplementation(async (id, _c, signal) => {
      if (id === "c1") {
        signal?.addEventListener("abort", () => pendingFirst.reject(new DOMException("Aborted", "AbortError")));
        return pendingFirst.promise;
      }
      return { ok: true, requestId: "m", data: { items: [userMessage("m2", "c2", "第二会话消息")], nextCursor: null } };
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "第一会话" });
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => {
      pendingFirst.resolve({ ok: true, requestId: "m", data: { items: [userMessage("m1", "c1", "不应串写")], nextCursor: null } });
    });
    expect(screen.queryByText("不应串写")).toBeNull();
  });

  it("renders empty/error states and appends conversation pagination", async () => {
    let attempts = 0;
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, requestId: "c", error: { code: "internal_error", message: "暂时失败", requestId: "c" } };
      if (attempts === 2) return { ok: true, requestId: "c", data: { items: [conversation("c1", "首个会话")], nextCursor: "next" } };
      return { ok: true, requestId: "c", data: { items: [conversation("c2", "更多会话")], nextCursor: null } };
    });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    expect(await screen.findByText(/暂时失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "首个会话" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".empty-state")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("更多会话")).toBeTruthy();
  });

  it("continues conversation pagination until the URL-selected conversation is found", async () => {
    const requestedCursors: string[] = [];
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockImplementation(async (cursor) => {
      requestedCursors.push(String(cursor));
      if (!cursor) return { ok: true, requestId: "c", data: { items: [conversation("c1", "首屏会话")], nextCursor: "next" } };
      return { ok: true, requestId: "c", data: { items: [conversation("target", "深页会话")], nextCursor: null } };
    });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter initialEntries={["/?conversation=target"]}><Workbench /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "深页会话" })).toBeTruthy();
    // SDK 数据层直接以 cursor 字符串翻页（不再拼成 ?cursor=next URL），断言第二页请求携带 "next"。
    expect(requestedCursors).toContain("next");
  });

  it("does not append a delayed message page after switching conversations", async () => {
    const delayedPage = deferred<Response>();
    let c1Requests = 0;
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: conversations, nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockImplementation(async (id, _c, signal) => {
      if (id === "c1") {
        c1Requests += 1;
        if (c1Requests === 1) return { ok: true, requestId: "m", data: { items: [userMessage("m1", "c1", "首条消息")], nextCursor: "more" } };
        signal?.addEventListener("abort", () => delayedPage.reject(new DOMException("Aborted", "AbortError")));
        return delayedPage.promise;
      }
      return { ok: true, requestId: "m", data: { items: [userMessage("m2", "c2", "第二会话消息")], nextCursor: null } };
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("首条消息");
    fireEvent.click(screen.getByRole("button", { name: "加载更多消息" }));
    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    expect(await screen.findByText("第二会话消息")).toBeTruthy();
    await act(async () => delayedPage.resolve({ ok: true, requestId: "m", data: { items: [userMessage("late", "c1", "迟到分页消息")], nextCursor: null } }));
    expect(screen.queryByText("迟到分页消息")).toBeNull();
  });

  it("does not create a conversation when New Chat is clicked; creates it on first message send", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockResolvedValue({
      ok: false,
      requestId: "run_failed",
      error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
    });
    const posts: string[] = [];
    const client = await import("../../shared/sdk/ohna-client");
    stubWorkspace(client);
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });
    vi.mocked(client.createConversation).mockImplementation(async ({ title }) => {
      posts.push(title);
      return { ok: true, requestId: "create", data: conversation("created", "新建任务") };
    });
    // 本用例不验证标题升级；让语义标题调用安全返回，避免 fire-and-forget 抛未处理 rejection。
    vi.mocked(client.generateConversationTitle).mockResolvedValue({ ok: true, requestId: "title", data: conversation("created", "新建任务") });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });

    // 点击 New Chat：不落盘、header 回到「新会话」、composer 可用。
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    await screen.findByRole("heading", { name: "新会话" });
    expect(posts).toHaveLength(0);

    // 发送首条真实消息才创建会话。
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "第一次任务" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it("switching workspace opens a fresh conversation draft instead of keeping the current history", async () => {
    const client = await import("../../shared/sdk/ohna-client");
    const workspaceA = stubWorkspace(client);
    const workspaceB = {
      workspaceId: "ws-other",
      displayPath: "/tmp/ohna-other",
      status: "authorized" as const
    };
    vi.mocked(client.listWorkspaces).mockResolvedValue({
      ok: true,
      requestId: "workspaces.list",
      data: [workspaceA, workspaceB]
    });
    vi.mocked(client.listConversations).mockResolvedValue({
      ok: true,
      requestId: "conversations.list",
      data: { items: [conversation("c1", "旧工作区会话")], nextCursor: null }
    });
    vi.mocked(client.listConversationMessages).mockResolvedValue({
      ok: true,
      requestId: "messages.list",
      data: { items: [userMessage("m1", "c1", "旧工作区记录")], nextCursor: null }
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("旧工作区记录");

    fireEvent.click(screen.getByRole("button", { name: `当前工作区 ${workspaceA.displayPath}` }));
    fireEvent.click(await screen.findByRole("button", { name: /ohna-other/ }));

    expect(await screen.findByRole("heading", { name: "新会话" })).toBeTruthy();
    expect(screen.queryByText("旧工作区记录")).toBeNull();
    expect(window.location.search).toBe("");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("adding a workspace also opens a fresh conversation draft", async () => {
    const client = await import("../../shared/sdk/ohna-client");
    const workspaceA = stubWorkspace(client);
    const workspaceB = {
      workspaceId: "ws-added",
      displayPath: "/tmp/ohna-added",
      status: "authorized" as const
    };
    vi.mocked(client.listConversations).mockResolvedValue({
      ok: true,
      requestId: "conversations.list",
      data: { items: [conversation("c1", "添加前会话")], nextCursor: null }
    });
    vi.mocked(client.listConversationMessages).mockResolvedValue({
      ok: true,
      requestId: "messages.list",
      data: { items: [userMessage("m1", "c1", "添加工作区前的记录")], nextCursor: null }
    });
    vi.mocked(client.pickWorkspace).mockResolvedValue({
      ok: true,
      requestId: "workspaces.pick",
      data: workspaceB
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("添加工作区前的记录");
    fireEvent.click(screen.getByRole("button", { name: `当前工作区 ${workspaceA.displayPath}` }));
    fireEvent.click(await screen.findByRole("button", { name: /选择其他目录/ }));

    await waitFor(() => expect(client.pickWorkspace).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "新会话" })).toBeTruthy();
    expect(screen.queryByText("添加工作区前的记录")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("requests a semantic title after the first message on a lazily-created conversation", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockResolvedValue({
      ok: false,
      requestId: "run_failed",
      error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
    });
    const titleCalls: Array<{ id: string; text: string }> = [];
    const client = await import("../../shared/sdk/ohna-client");
    stubWorkspace(client);
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });
    vi.mocked(client.createConversation).mockResolvedValue({ ok: true, requestId: "create", data: conversation("created", "截断标题") });
    vi.mocked(client.generateConversationTitle).mockImplementation(async (id, text) => {
      titleCalls.push({ id, text });
      return { ok: true, requestId: "title", data: conversation("created", "修复类型错误") };
    });
    vi.mocked(client.updateConversation).mockResolvedValue({ ok: true, requestId: "patch", data: conversation("created", "截断标题") });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("暂无历史会话，创建一个开始编码。");
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "帮我修复这段 TypeScript 类型错误" } });
    fireEvent.submit(textbox.closest("form")!);

    // 首条消息发送后必须发起 generate-title POST，携带首条用户消息原文。
    await waitFor(() => expect(titleCalls).toHaveLength(1));
    // 桌面数据层走 SDK：断言 generateConversationTitle 被调用，携带会话 id 与首条用户消息原文。
    expect(titleCalls[0].id).toBe("created");
    expect(titleCalls[0].text).toBe("帮我修复这段 TypeScript 类型错误");
  });

  it("does not re-PATCH the title or regenerate it on subsequent messages in the same conversation", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockResolvedValue({
      ok: false,
      requestId: "run_failed",
      error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
    });
    const generateTitlePosts: string[] = [];
    const titlePatches: string[] = [];
    const client = await import("../../shared/sdk/ohna-client");
    stubWorkspace(client);
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });
    vi.mocked(client.createConversation).mockResolvedValue({ ok: true, requestId: "create", data: conversation("created", "修复类型错误") });
    vi.mocked(client.generateConversationTitle).mockImplementation(async (id) => {
      generateTitlePosts.push(`conversations/${id}/generate-title`);
      return { ok: true, requestId: "title", data: conversation("created", "修复类型错误") };
    });
    vi.mocked(client.updateConversation).mockImplementation(async (id, input) => {
      if (input.title) titlePatches.push(input.title);
      return { ok: true, requestId: "patch", data: conversation("created", "修复类型错误") };
    });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("暂无历史会话，创建一个开始编码。");
    const textbox = screen.getByRole("textbox");

    // 首条消息懒创建会话并触发一次语义标题升级。
    fireEvent.change(textbox, { target: { value: "帮我修复这段 TypeScript 类型错误" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(generateTitlePosts).toHaveLength(1));
    await waitFor(() => expect(createAndStreamRun).toHaveBeenCalledTimes(1));

    // 第二条消息复用已创建会话：既不改写标题（覆盖语义标题），也不再次生成语义标题。
    fireEvent.change(textbox, { target: { value: "再帮我看看另一个文件" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(createAndStreamRun).toHaveBeenCalledTimes(2));

    expect(generateTitlePosts).toHaveLength(1);
    expect(titlePatches).toHaveLength(0);
  });

  it("skips the known-empty initial history so a newly persisted user message cannot duplicate live state", async () => {
    let historyRequests = 0;
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockResolvedValue({
      ok: false,
      requestId: "run_failed",
      error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
    });
    const client = await import("../../shared/sdk/ohna-client");
    stubWorkspace(client);
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [], nextCursor: null } });
    vi.mocked(client.createConversation).mockResolvedValue({ ok: true, requestId: "create", data: conversation("created", "首次问题") });
    // 本用例只验证「跳过已知空历史」，不验证标题升级；让语义标题调用安全返回，避免 fire-and-forget 抛未处理 rejection。
    vi.mocked(client.generateConversationTitle).mockResolvedValue({ ok: true, requestId: "title", data: conversation("created", "首次问题") });
    vi.mocked(client.listConversationMessages).mockImplementation(async (id) => {
      historyRequests += 1;
      return { ok: true, requestId: "m", data: { items: [userMessage("persisted", "created", "首次问题")], nextCursor: null } };
    });

    const { container } = render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByText("暂无历史会话，创建一个开始编码。");
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
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      options?.onAccepted?.(accepted("run-accepted"));
      return {
        ok: false,
        requestId: "stream_failed",
        error: { code: "internal_error", message: "stream failed", requestId: "stream_failed" }
      };
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "已接受问题" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe(""));
  });

  it("cancels a server-created Run when stop was requested before its delayed accepted response", async () => {
    const { cancelRun, createAndStreamRun } = await import("../../shared/sdk/ohna-client");
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
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

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
    expect(screen.getByText("已停止服务端任务，输入已保留。")).toBeTruthy();
  });

  it("clears the submitted draft and completes the Run when pre-accepted cancellation fails", async () => {
    const { cancelRun, createAndStreamRun } = await import("../../shared/sdk/ohna-client");
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
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

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
    const { cancelRun, createAndStreamRun } = await import("../../shared/sdk/ohna-client");
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
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

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
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (request) => {
      runRequests.push(request);
      return {
        ok: false,
        requestId: "run_failed",
        error: { code: "internal_error", message: "network failed", requestId: "run_failed" }
      };
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

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
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
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
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "解释这段类型错误" } });
    fireEvent.submit(textbox.closest("form")!);
    await waitFor(() => expect(runRequests).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: "重新生成回答" }));
    await waitFor(() => expect(runRequests).toHaveLength(2));

    expect(runRequests[1].clientMessageId).not.toBe(runRequests[0].clientMessageId);
    expect(runRequests[1].message).toBe(runRequests[0].message);
    expect(runRequests[1].modelId).toBe(runRequests[0].modelId);
  });

  it("keeps the toolCall message and the summary message of a multi-message run", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-multi"));
      options?.onEvent?.(streamEvent(1, "message_start", { message: { role: "assistant", content: [] } }));
      options?.onEvent?.(streamEvent(2, "message_update", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] }
        }
      }));
      options?.onEvent?.(streamEvent(3, "tool_execution_end", {
        toolCallId: "call-1",
        toolName: "read",
        result: [{ type: "text", text: "文件内容" }],
        isError: false
      }));
      options?.onEvent?.(streamEvent(4, "message_end", {
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] }
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
          { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
          { role: "toolResult", content: { toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "文件内容" }], isError: false } },
          { role: "assistant", content: [{ type: "text", text: "最终总结回答" }] }
        ]
      }));
      return { ok: true, requestId: "terminal", data: { status: "completed", requestId: "terminal" } };
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "多消息 run" } });
    fireEvent.submit(textbox.closest("form")!);

    // 终态渲染里两条 assistant 消息的块都在：工具调用块 + 总结正文。
    await screen.findByText("最终总结回答");
    expect(screen.getByText("read")).toBeTruthy();
    fireEvent.click(screen.getByText("read"));
    expect(screen.getByText("文件内容")).toBeTruthy();
  });

  it("shows retry for a failed message restored from conversation history", async () => {
    const runRequests: Array<{ message: string; modelId?: string }> = [];
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (request) => {
      runRequests.push(request);
      return failureResult("agent_failed", "still unavailable");
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [
      userMessage("user-1", "c1", "历史失败问题"),
      { ...assistantMessage("assistant-1", "c1", "agent_failed", "run-1"), stopReason: "error", sequence: 2 }
    ], nextCursor: null } });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "重新生成回答" }));
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(runRequests[0]).toMatchObject({ message: "历史失败问题", modelId: "mock" });
  });
});

describe("Workbench confirmation cards (W-4)", () => {
  it("renders a pending card on confirmation_requested and posts the allow decision", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-confirm"));
      options?.onEvent?.(streamEvent(1, "tool_execution_start", {
        toolCallId: "call-w1",
        toolName: "write"
      }));
      options?.onEvent?.(streamEvent(2, "confirmation_requested", {
        toolCallId: "call-w1",
        toolName: "write",
        args: { path: "notes.md", content: "x" },
        summary: "写文件 notes.md"
      }));
      // 不给终态：卡片保持未决。
      return new Promise(() => undefined);
    });
    const posts: Array<{ url: string; body: unknown }> = [];
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });
    vi.mocked(client.submitConfirmation).mockImplementation(async (runId, toolCallId, decision) => {
      posts.push({ url: `runs/${runId}/confirmations/${toolCallId}`, body: { decision } });
      return { ok: true, requestId: "conf", data: { toolCallId, decision } };
    });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "把 notes.md 改一下" } });
    fireEvent.submit(textbox.closest("form")!);

    expect(await screen.findByText("写文件 notes.md")).toBeTruthy();
    // 关键参数行展示 path。
    const container = screen.getByText("写文件 notes.md").closest(".confirmation-card")!;
    expect(container.querySelector(".confirmation-param code")?.textContent).toBe("notes.md");
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ decision: "allow" });
    // 提交后等待 end 期间按钮保持禁用（提交中）。
    expect(screen.getByRole("button", { name: "提交中" })).toBeTruthy();
  });

  it("shows the structured error on the card when the decision request fails", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-confirm"));
      options?.onEvent?.(streamEvent(1, "confirmation_requested", {
        toolCallId: "call-w2",
        toolName: "bash",
        args: { command: "pnpm test" },
        summary: "执行命令 pnpm test"
      }));
      return new Promise(() => undefined);
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });
    vi.mocked(client.submitConfirmation).mockResolvedValue({ ok: false, requestId: "conf", error: { code: "conflict", message: "Run 已结束，无法再确认。", requestId: "conf" } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "跑一下测试" } });
    fireEvent.submit(textbox.closest("form")!);

    fireEvent.click(await screen.findByRole("button", { name: "拒绝" }));
    expect(await screen.findByText(/conflict: Run 已结束/)).toBeTruthy();
  });

  it("resolves a pending card to 已允许 when the tool execution ends without error", async () => {
    const { createAndStreamRun } = await import("../../shared/sdk/ohna-client");
    let emit: ((event: RunStreamEventDtoV2) => void) | undefined;
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      options?.onEvent?.(streamEvent(1, "confirmation_requested", {
        toolCallId: "call-r1",
        toolName: "write",
        args: { path: "a.md" },
        summary: "写文件 a.md"
      }));
      emit = options?.onEvent;
      return new Promise(() => undefined);
    });
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [], nextCursor: null } });

    render(<MemoryRouter><Workbench /></MemoryRouter>);
    await screen.findByRole("heading", { name: "已有会话" });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "写文件" } });
    fireEvent.submit(textbox.closest("form")!);

    // 先等未决卡片出现（此时 onEvent 已可安全持有）。
    await screen.findByText("写文件 a.md");
    // 收到无错误的 tool_execution_end → 卡片收敛为已允许。
    await act(async () => {
      emit?.(streamEvent(2, "tool_execution_end", {
        toolCallId: "call-r1",
        toolName: "write",
        isError: false
      }));
    });
    expect(await screen.findByText("已允许")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
  });
});

describe("Workbench replay restore (W-9)", () => {
  it("restores a pending confirmation card via SSE replay when the last history user message carries a runId", async () => {
    const { replayRunEvents } = await import("../../shared/sdk/ohna-client");
    // 不再测 no-op：捕获 replay 回调，可控注入 confirmation_requested。
    let replayOnEvent: ((event: RunStreamEventDtoV2) => void) | undefined;
    vi.mocked(replayRunEvents).mockImplementation(async (_runId, options) => {
      replayOnEvent = options?.onEvent;
    });
    const posts: Array<{ url: string; body: unknown }> = [];
    const client = await import("../../shared/sdk/ohna-client");
    vi.mocked(client.listConversations).mockResolvedValue({ ok: true, requestId: "c", data: { items: [conversation("c1", "已有会话")], nextCursor: null } });
    vi.mocked(client.listConversationMessages).mockResolvedValue({ ok: true, requestId: "m", data: { items: [{ ...userMessage("u-last", "c1", "把 notes.md 改一下"), runId: "run-replay" }], nextCursor: null } });
    vi.mocked(client.submitConfirmation).mockImplementation(async (runId, toolCallId, decision) => {
      posts.push({ url: `runs/${runId}/confirmations/${toolCallId}`, body: { decision } });
      return { ok: true, requestId: "conf", data: { toolCallId, decision } };
    });

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("把 notes.md 改一下");
    await waitFor(() => expect(replayOnEvent).toBeDefined());

    // SSE replay 投递 confirmation_requested，且没有后续 tool_execution_end → 卡片保持未决。
    await act(async () => {
      replayOnEvent?.({
        eventId: "event-1",
        runId: "run-replay",
        requestId: "request_run-replay",
        conversationId: "c1",
        sequence: 1,
        type: "confirmation_requested",
        payload: {
          toolCallId: "call-replay",
          toolName: "write",
          args: { path: "notes.md", content: "x" },
          summary: "写文件 notes.md"
        },
        createdAt: "2026-07-25T00:00:00.000Z"
      });
    });
    expect(await screen.findByText("写文件 notes.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("runs/run-replay/confirmations/call-replay");
    expect(posts[0].body).toEqual({ decision: "allow" });
  });
});

function conversation(conversationId: string, title: string) {
  return {
    conversationId,
    title,
    status: "active",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    lastMessageAt: "2026-07-25T00:00:00.000Z",
    workspaceId: "work-default"
  };
}

/** 侧栏 fixture：两会话默认工作区，复用 `conversation`。 */
const conversations = [
  conversation("c1", "第一会话"),
  conversation("c2", "第二会话")
];

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
      toolName: "read",
      content: [{ type: "text", text: "文件内容已返回" }],
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
    userMessageId: `msg_${runId}`,
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
