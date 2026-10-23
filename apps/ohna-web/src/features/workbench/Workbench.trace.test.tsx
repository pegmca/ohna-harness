/**
 * TC-L2-03 / TC-L2-04 · Trace 抽屉与 Workbench 集成。
 *
 * - `/trace` 路由已删除：访问该深链回落到 Workbench（router 只剩 `*` 兜底，`/settings` 亦已删除）；
 * - chat 头部 Trace 开关可展开/收起抽屉，抽屉默认收起且不读 URL（刷新后回到对话视图）；
 * - 右侧排查位互斥：打开 Trace 收起 RunDetailPanel，反之亦然。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

vi.mock("../../shared/api/run-stream-client", () => ({
  createAndStreamRun: vi.fn(),
  cancelRun: vi.fn(),
  replayRunEvents: vi.fn(async () => undefined)
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
  }))
}));

const listConversationRuns = vi.fn();
vi.mock("../trace/trace-client", () => ({
  listConversationRuns: (...args: unknown[]) => listConversationRuns(...args)
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * 会话 fixture。
 *
 * @param conversationId id。
 * @param title 标题。
 * @returns 会话 DTO（工作区与 /api/health 一致）。
 */
function conversation(conversationId: string, title: string) {
  return {
    conversationId,
    title,
    status: "active" as const,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    lastMessageAt: "2026-10-20T00:00:00.000Z",
    workspaceRoot: "/work/a"
  };
}

/**
 * 构造 assistant 消息（带 runId 与工具调用块，供「查看开发者详情」打开右侧面板）。
 *
 * @param conversationId 会话 ID。
 * @returns LinearMessage 列表。
 */
function messages(conversationId: string) {
  return [
    {
      messageId: "u1",
      conversationId,
      role: "user",
      content: "修一下类型错误",
      messageType: "normal",
      sequence: 1,
      createdAt: "2026-10-20T00:00:01.000Z"
    },
    {
      messageId: "a1",
      conversationId,
      role: "assistant",
      runId: "run-1",
      content: [{ type: "text", text: "已经修复。" }],
      messageType: "normal",
      sequence: 2,
      modelId: "mock",
      stopReason: "stop",
      createdAt: "2026-10-20T00:00:02.000Z"
    }
  ];
}

/**
 * 安装 fetch stub。
 *
 * @returns fetch mock（用于断言请求集合）。
 */
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) => new Response(JSON.stringify({ ok: true, requestId: "t", data }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    if (url.startsWith("/api/health")) {
      return new Response(JSON.stringify({ mode: "local", workspaceRoot: "/work/a", pid: 1, dataDir: "/tmp/ohna" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("/api/conversations?")) return json({ items: [conversation("c1", "已有会话")] });
    if (url.includes("/c1/messages")) return json({ items: messages("c1") });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Workbench Trace 抽屉（L2）", () => {
  it("默认收起；点击 Trace 开关展开抽屉并按当前会话加载 run", async () => {
    listConversationRuns.mockResolvedValue({
      ok: true,
      requestId: "r",
      data: [{
        runId: "run-1",
        requestId: "req-1",
        conversationId: "c1",
        modelId: "mock",
        mode: "auto",
        source: "composer",
        status: "completed",
        createdAt: "2026-10-20T00:00:02.000Z"
      }]
    });
    const fetchMock = stubFetch();

    const { container } = render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已经修复。");
    // 初始收起：没有抽屉、没有列位，也不加载 run 列表。
    expect(screen.queryByRole("complementary", { name: "Trace" })).toBeNull();
    expect(listConversationRuns).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: false }));
    const drawer = await screen.findByRole("complementary", { name: "Trace" });
    expect(within(drawer).getByRole("heading", { level: 2, name: "已有会话" })).toBeTruthy();
    await waitFor(() => expect(listConversationRuns).toHaveBeenCalledWith("c1", expect.anything()));
    expect(container.querySelector(".agent-app-shell")?.className).toContain("has-trace-panel");
    // 抽屉数据跟随当前会话：只消费钩子内的事件流请求，不直接按会话重拉列表
    // （run 列表走 mocked listConversationRuns；事件流请求即 replay/follow，由 run-stream-client mock 承担）。
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/conversations"))).toBe(true);

    // 再点一次收起。
    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: true }));
    expect(screen.queryByRole("complementary", { name: "Trace" })).toBeNull();
    expect(container.querySelector(".agent-app-shell")?.className).not.toContain("has-trace-panel");
  });

  it("TC-L2-04: 打开 Trace 收起运行详情，反之亦然（右侧位互斥）", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [] });
    stubFetch();

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已经修复。");

    // 打开运行详情（右侧位 A）。
    fireEvent.click(screen.getByRole("button", { name: "查看开发者详情" }));
    expect(await screen.findByRole("complementary", { name: "运行详情" })).toBeTruthy();

    // 打开 Trace → 运行详情让位。
    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: false }));
    expect(await screen.findByRole("complementary", { name: "Trace" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "运行详情" })).toBeNull();

    // 再打开一次运行详情 → Trace 让位。
    fireEvent.click(screen.getByRole("button", { name: "查看开发者详情" }));
    expect(await screen.findByRole("complementary", { name: "运行详情" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Trace" })).toBeNull();
  });

  it("会话切换后抽屉保持展开，数据跟随新会话", async () => {
    listConversationRuns.mockImplementation(async (conversationId: string) => ({
      ok: true,
      requestId: "r",
      data: conversationId === "c1"
        ? [{ runId: "run-1", requestId: "req-1", conversationId: "c1", modelId: "mock", mode: "auto", source: "composer", status: "completed", createdAt: "2026-10-20T00:00:02.000Z" }]
        : []
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (data: unknown) => new Response(JSON.stringify({ ok: true, requestId: "t", data }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      if (url.startsWith("/api/health")) {
        return new Response(JSON.stringify({ mode: "local", workspaceRoot: "/work/a", pid: 1, dataDir: "/tmp/ohna" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.startsWith("/api/conversations?")) {
        return json({ items: [conversation("c1", "第一会话"), conversation("c2", "第二会话")] });
      }
      if (url.includes("/c2/messages")) return json({ items: [] });
      if (url.includes("/c1/messages")) return json({ items: messages("c1") });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已经修复。");
    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: false }));
    await screen.findByRole("complementary", { name: "Trace" });

    fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
    await waitFor(() => expect(listConversationRuns).toHaveBeenCalledWith("c2", expect.anything()));
    // 抽屉保持展开，且内容随新会话切换（本会话无 run）。
    expect(screen.getByRole("complementary", { name: "Trace" })).toBeTruthy();
    expect(await screen.findByText("本会话还没有运行记录。")).toBeTruthy();
  });
});
