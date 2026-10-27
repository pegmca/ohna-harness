/**
 * BUG-002 · 跨工作区会话可在 web 侧继续对话（D2 只读限制已移除）。
 *
 * 桌面端数据层已迁移到 preload SDK（`shared/sdk/ohna-client`），按会话 `workspaceId` 分组；
 * composer 不再比较 `GET /api/health` 的实例工作区与会话工作区：
 * composer 不再禁用、不再渲染「该会话属于其他工作区」提示，也不再按 `?workspaceRoot=` 额外拉列表。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import * as client from "../../shared/sdk/ohna-client";

vi.mock("../../shared/sdk/ohna-client");

const mocked = vi.mocked(client);

/**
 * 构造会话 fixture（ConversationSummaryDto，桌面端按 workspaceId 分组）。
 *
 * @param id id。
 * @param title 标题。
 * @param workspaceId 工作区标识。
 * @returns 会话摘要 DTO。
 */
function conversation(id: string, title: string, workspaceId: string) {
  return {
    conversationId: id,
    title,
    status: "active" as const,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    lastMessageAt: "2026-10-20T00:00:00.000Z",
    workspaceId
  };
}

/**
 * 构造会话历史单条用户消息（LinearMessageDto），供 SDK 的 `listConversationMessages` 返回。
 *
 * @param conversationId 会话 id。
 * @param text 用户消息文本。
 * @returns 线性消息对象。
 */
function historyMessage(conversationId: string, text: string) {
  return {
    messageId: "m1",
    conversationId,
    role: "user",
    content: text,
    messageType: "normal",
    sequence: 1,
    createdAt: "2026-10-20T00:00:01.000Z"
  };
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Workbench 跨工作区会话", () => {
  it("会话属于其他工作区时 composer 仍可输入，且不再出现只读提示", async () => {
    const other = conversation("c-other", "其他工作区会话", "work-b");
    const healthRequests: string[] = [];
    mocked.listConversations.mockResolvedValue({ ok: true, requestId: "list", data: { items: [other], nextCursor: null } });
    mocked.listConversationMessages.mockResolvedValue({
      ok: true,
      requestId: "messages",
      data: { items: [historyMessage("c-other", "其他工作区历史消息")], nextCursor: null }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) {
        healthRequests.push(url);
        return healthLocal();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c-other"]}><Workbench /></MemoryRouter>);
    await screen.findByText("其他工作区历史消息");
    await waitFor(() => expect(healthRequests.some((url) => url.startsWith("/api/health"))).toBe(true));

    const textarea = screen.getByPlaceholderText("许下你的愿望") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.queryByText(/该会话属于其他工作区/)).toBeNull();
  });

  it("跨工作区会话可以直接发送消息（不再被只读守卫拦下）", async () => {
    const runs: Array<{ conversationId: string; message: string }> = [];
    // 模型目录未就绪时 composer 的 selectedModelId 为空，submitAgentMessage 会早退；
    // 桌面数据层走 SDK，这里直接 mock listModels（不再走 /api/models fetch）。
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
          capabilities: { structuredOutput: true, toolCalling: true },
          contextWindow: 128_000,
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }]
      }
    });
    mocked.createAndStreamRun.mockImplementation(async (request, options) => {
      runs.push(request);
      await options?.onAccepted?.({
        runId: "run-cross",
        requestId: "request_run-cross",
        conversationId: "c-other",
        modelId: "mock",
        status: "queued"
      });
      return { ok: true, requestId: "terminal", data: { status: "completed", requestId: "terminal" } };
    });
    const other = conversation("c-other", "其他工作区会话", "work-b");
    mocked.listConversations.mockResolvedValue({ ok: true, requestId: "list", data: { items: [other], nextCursor: null } });
    mocked.listConversationMessages.mockResolvedValue({
      ok: true,
      requestId: "messages",
      data: { items: [historyMessage("c-other", "其他工作区历史消息")], nextCursor: null }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) return healthLocal();
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
    const same = conversation("c-same", "本工作区会话", "work-a");
    mocked.listConversations.mockResolvedValue({ ok: true, requestId: "list", data: { items: [same], nextCursor: null } });
    mocked.listConversationMessages.mockResolvedValue({
      ok: true,
      requestId: "messages",
      data: { items: [historyMessage("c-same", "本工作区历史消息")], nextCursor: null }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) return healthLocal();
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<MemoryRouter initialEntries={["/?conversation=c-same"]}><Workbench /></MemoryRouter>);
    await screen.findByText("本工作区历史消息");
    expect(screen.queryByText(/该会话属于其他工作区/)).toBeNull();
    expect((screen.getByPlaceholderText("许下你的愿望") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
