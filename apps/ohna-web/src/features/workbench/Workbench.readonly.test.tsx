/**
 * TC-L1-04 · 跨工作区会话只读（D2）。
 *
 * 当 `localMode.workspaceRoot` 与会话 `workspaceRoot` 不一致时，composer 禁用并展示只读提示；
 * 同工作区会话不受影响。
 */
import { cleanup, render, screen } from "@testing-library/react";
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

describe("Workbench 跨工作区只读", () => {
  it("会话属于其他工作区时 composer 禁用并提示", async () => {
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
    expect(await screen.findByText(/该会话属于其他工作区/)).toBeTruthy();
    const textarea = screen.getByPlaceholderText("描述一个编码任务…") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("同工作区会话不触发只读提示", async () => {
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
  });
});
