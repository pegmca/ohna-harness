/**
 * BUG-002 · 跨工作区会话可在 web 侧继续对话（D2 只读限制已移除）。
 *
 * 服务端（packages/serve 的 RunManagerOptions.resolveWorkspace）已按会话 workspaceRoot 动态装配
 * agent 上下文，因此前端不再比较 `GET /api/health` 的实例工作区与会话 workspaceRoot：
 * composer 不再禁用、不再渲染「该会话属于其他工作区」提示，也不再按 `?workspaceRoot=` 额外拉列表。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * 构造会话 fixture。
 *
 * @param id id。
 * @param title 标题。
 * @param workspaceRoot 工作区。
 * @returns 会话 DTO。
 */
function conversation(id: string, title: string, workspaceRoot: string) {
  return {
    conversationId: id,
    title,
    status: "active" as const,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    lastMessageAt: "2026-10-20T00:00:00.000Z",
    workspaceRoot
  };
}

/**
 * 构造会话历史响应。
 *
 * @param conversationId 会话 id。
 * @param text 用户消息文本。
 * @returns Response。
 */
function okHistory(conversationId: string, text: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: "test",
    data: {
      items: [{
        messageId: "m1",
        conversationId,
        role: "user",
        content: text,
        messageType: "normal",
        sequence: 1,
        createdAt: "2026-10-20T00:00:01.000Z"
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 构造健康检查响应（声明当前实例工作区为 /work/a）。
 *
 * @returns Response。
 */
function healthLocal(): Response {
  return new Response(JSON.stringify({
    mode: "local",
    workspaceRoot: "/work/a",
    model: { id: "mock", provider: "mock" },
    pid: 1,
    dataDir: "/tmp/ohna"
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 构造会话列表响应。
 *
 * @param items 会话 DTO 列表。
 * @returns Response。
 */
function okList(items: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, requestId: "test", data: { items } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Workbench 跨工作区会话", () => {
  it("会话属于其他工作区时 composer 仍可输入，且不再出现只读提示", async () => {
    const other = conversation("c-other", "其他工作区会话", "/work/b");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("/api/health")) return healthLocal();
      if (url.startsWith("/api/conversations?")) return okList([other]);
      if (url.includes("/c-other/messages")) return okHistory("c-other", "其他工作区历史消息");
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c-other"]}><Workbench /></MemoryRouter>);
    await screen.findByText("其他工作区历史消息");
    await waitFor(() => expect(requests.some((url) => url.startsWith("/api/health"))).toBe(true));

    const textarea = screen.getByPlaceholderText("描述一个编码任务…") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.queryByText(/该会话属于其他工作区/)).toBeNull();
    // 列表查询只保留侧栏全量拉取，不再按 ?workspaceRoot= 追加本工作区会话。
    expect(requests.filter((url) => url.startsWith("/api/conversations?"))).toEqual(["/api/conversations?limit=30"]);
  });

  it("跨工作区会话可以直接发送消息（不再被只读守卫拦下）", async () => {
    const { createAndStreamRun } = await import("../../shared/api/run-stream-client");
    const runs: Array<{ conversationId: string; message: string }> = [];
    vi.mocked(createAndStreamRun).mockImplementation(async (request, options) => {
      runs.push(request);
      await options?.onAccepted?.({
        runId: "run-cross",
        requestId: "request_run-cross",
        conversationId: "c-other",
        modelId: "mock",
        status: "queued",
        eventsUrl: "/events",
        snapshotUrl: "/snapshot"
      });
      return { ok: true, requestId: "terminal", data: { status: "completed", requestId: "terminal" } };
    });
    const other = conversation("c-other", "其他工作区会话", "/work/b");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) return healthLocal();
      if (url.startsWith("/api/conversations?")) return okList([other]);
      if (url.includes("/c-other/messages")) return okHistory("c-other", "其他工作区历史消息");
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c-other"]}><Workbench /></MemoryRouter>);
    await screen.findByText("其他工作区历史消息");
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "在 /work/b 继续干活" } });
    await act(async () => {
      fireEvent.submit(textbox.closest("form")!);
    });

    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ conversationId: "c-other", message: "在 /work/b 继续干活" });
  });

  it("同工作区会话同样没有只读提示", async () => {
    const same = conversation("c-same", "本工作区会话", "/work/a");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) return healthLocal();
      if (url.startsWith("/api/conversations?")) return okList([same]);
      if (url.includes("/c-same/messages")) return okHistory("c-same", "本工作区历史消息");
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c-same"]}><Workbench /></MemoryRouter>);
    await screen.findByText("本工作区历史消息");
    expect(screen.queryByText(/该会话属于其他工作区/)).toBeNull();
    expect((screen.getByPlaceholderText("描述一个编码任务…") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
