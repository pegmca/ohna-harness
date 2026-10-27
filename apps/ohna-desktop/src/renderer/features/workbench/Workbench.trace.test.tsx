/**
 * TC-L2-03 / TC-L2-04 · Trace 抽屉与 Workbench 集成。
 *
 * - `/trace` 路由已删除：访问该深链回落到 Workbench（router 只剩 `*` 兜底，`/settings` 亦已删除）；
 * - chat 头部 Trace 开关可展开/收起抽屉，抽屉默认收起且不读 URL（刷新后回到对话视图）；
 * - 消息内不再提供「查看开发者详情」入口，运行排查统一走头部 Trace 开关。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import * as client from "../../shared/sdk/ohna-client";

vi.mock("../../shared/sdk/ohna-client");

const mocked = vi.mocked(client);

const listConversationRuns = mocked.listConversationRuns;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * 会话 fixture（ConversationSummaryDto，桌面端按 workspaceId 分组）。
 *
 * @param conversationId id。
 * @param title 标题。
 * @returns 会话摘要 DTO（工作区与 /api/health 一致）。
 */
function conversation(conversationId: string, title: string) {
  return {
    conversationId,
    title,
    status: "active" as const,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    lastMessageAt: "2026-10-20T00:00:00.000Z",
    workspaceId: "work-a"
  };
}

/**
 * 构造 assistant 消息（带 runId，供头部 Trace 开关加载当前会话的 run）。
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
 * 安装 SDK + `/api/health` fetch stub。
 *
 * 会话列表/消息/模型走 preload SDK；仅健康探针保留 fetch（设置连接状态分区，按设计不迁移）。
 *
 * @returns fetch mock（用于断言健康探针）。
 */
function stubFetch() {
  mocked.listConversations.mockResolvedValue({
    ok: true,
    requestId: "list",
    data: { items: [conversation("c1", "已有会话")], nextCursor: null }
  });
  mocked.listConversationMessages.mockResolvedValue({
    ok: true,
    requestId: "messages",
    data: { items: messages("c1"), nextCursor: null }
  });
  mocked.listModels.mockResolvedValue({
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
  });
  mocked.createAndStreamRun.mockResolvedValue({ ok: true, requestId: "run", data: { status: "completed", requestId: "run" } });
  mocked.cancelRun.mockResolvedValue({ ok: true, requestId: "run", data: null });
  mocked.replayRunEvents.mockResolvedValue(undefined);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/health")) {
      return new Response(JSON.stringify({ mode: "local", workspaceRoot: "/work/a", pid: 1, dataDir: "/tmp/ohna" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
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
    // 抽屉数据跟随当前会话：事件流经 SDK 的 replayRunEvents（终态 run）/ followRunEvents 承载，
    // 不再发 /api/conversations 之类的 HTTP 请求；这里断言终态 run 走 replay 通道。
    expect(mocked.replayRunEvents).toHaveBeenCalled();

    // 再点一次收起。
    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: true }));
    expect(screen.queryByRole("complementary", { name: "Trace" })).toBeNull();
    expect(container.querySelector(".agent-app-shell")?.className).not.toContain("has-trace-panel");
  });

  it("TC-L2-04: 消息内不再展示开发者详情入口，Trace 只从头部开关打开", async () => {
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
    stubFetch();

    render(<MemoryRouter initialEntries={["/?conversation=c1"]}><Workbench /></MemoryRouter>);
    await screen.findByText("已经修复。");

    // 运行状态仍以单行摘要展示，但不再有展开入口，避免与 Trace 抽屉重复。
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看开发者详情" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Trace" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Trace", expanded: false }));
    const drawer = await screen.findByRole("complementary", { name: "Trace" });
    expect(within(drawer).getByRole("listitem", { name: "run-1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("会话切换后抽屉保持展开，数据跟随新会话", async () => {
    listConversationRuns.mockImplementation(async (conversationId: string) => ({
      ok: true,
      requestId: "r",
      data: conversationId === "c1"
        ? [{ runId: "run-1", requestId: "req-1", conversationId: "c1", modelId: "mock", mode: "auto", source: "composer", status: "completed", createdAt: "2026-10-20T00:00:02.000Z" }]
        : []
    }));
    mocked.listConversations.mockResolvedValue({
      ok: true,
      requestId: "list",
      data: { items: [conversation("c1", "第一会话"), conversation("c2", "第二会话")], nextCursor: null }
    });
    mocked.listConversationMessages.mockImplementation(async (conversationId: string) => ({
      ok: true,
      requestId: "messages",
      data: {
        items: conversationId === "c1" ? messages("c1") : [],
        nextCursor: null
      }
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) {
        return new Response(JSON.stringify({ mode: "local", workspaceRoot: "/work/a", pid: 1, dataDir: "/tmp/ohna" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
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
