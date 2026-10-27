/**
 * BUG-001 · run 失败时的「错误落点唯一化」。
 *
 * 失败信息只应出现一次且如实：
 * - 有残留文本（流式输出到一半失败）：正文保留残留文本，结构化错误只走气泡 error-block；
 * - 无残留文本（创建 / 传输即失败）：正文直接承载格式化错误，气泡不再重复 error-block；
 * - composer 提示统一为「请求失败，错误详情见下方消息。」，不再断言「已写入 assistant 消息」。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiErrorCode, RunStreamEventDtoV2 } from "@aiagent/types";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

vi.mock("../../shared/sdk/ohna-client");

const MODELS = {
  ok: true as const,
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
};

/** 旧提示文案（BUG-001 中被删除的误导性硬编码）。 */
const LEGACY_HINT = "请求失败，已把结构化错误写入当前 assistant 消息。";
/** 新提示文案：只指出错误在下方消息里，不预设错误写在哪个字段。 */
const NEW_HINT = "请求失败，错误详情见下方消息。";

/** @returns 会话列表桩（含 workspaceId）。 */
function listConversationsResult() {
  return {
    ok: true as const,
    requestId: "test",
    data: {
      items: [{
        conversationId: "c1",
        title: "已有会话",
        status: "active" as const,
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
        lastMessageAt: "2026-10-20T00:00:00.000Z",
        workspaceId: "work-a"
      }]
    }
  };
}

/** @returns 空历史桩。 */
function emptyHistory() {
  return { ok: true as const, requestId: "test", data: { items: [] } };
}

/** @param runId Run ID。 @returns accepted payload。 */
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

/** @param sequence 序号。 @param text 累积文本。 @returns run 事件。 */
function textEvent(sequence: number, text: string): RunStreamEventDtoV2 {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    requestId: "request_run-1",
    conversationId: "c1",
    sequence,
    type: "message_update",
    payload: {
      message: { role: "assistant", content: [{ type: "text", text }] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        partial: { role: "assistant", content: [{ type: "text", text }] }
      }
    },
    createdAt: "2026-10-20T00:00:00.000Z"
  };
}

/** @param code 错误码。 @param message 错误文案。 @param details 诊断字段。 @returns 失败 ApiResult。 */
function failedResult(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
  return {
    ok: false as const,
    requestId: "request_failed",
    error: { code, message, requestId: "request_failed", ...(details ? { details } : {}) }
  };
}

/** 渲染工作台并提交一条消息。 @param text 用户输入。 @returns 组件容器与输入框。 */
async function renderAndSubmit(text: string) {
  const view = render(<MemoryRouter><Workbench /></MemoryRouter>);
  await screen.findByRole("heading", { name: "已有会话" });
  const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value: text } });
  await fireEvent.submit(textbox.closest("form")!);
  return { container: view.container, textbox };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Workbench run 失败信息落点（BUG-001）", () => {
  it("有残留文本时正文保留残留，结构化错误只在 error-block 展示一次", async () => {
    const { createAndStreamRun, listConversations, listConversationMessages, listModels } =
      await import("../../shared/sdk/ohna-client");
    vi.mocked(listModels).mockResolvedValue(MODELS);
    vi.mocked(listConversations).mockResolvedValue(listConversationsResult());
    vi.mocked(listConversationMessages).mockResolvedValue(emptyHistory());
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-1"));
      options?.onEvent?.(textEvent(1, "半截回答"));
      return failedResult("agent_failed", "LLM request timed out.");
    });

    const { container } = await renderAndSubmit("解释这段类型错误");

    expect(await screen.findByText("半截回答")).toBeTruthy();
    await waitFor(() => expect(container.querySelectorAll(".error-block")).toHaveLength(1));
    expect(container.querySelector(".error-block")?.textContent).toContain("agent_failed: LLM request timed out.");
    expect(screen.queryAllByText(/agent_failed: LLM request timed out\./)).toHaveLength(1);
    expect(screen.getByText(NEW_HINT)).toBeTruthy();
    expect(screen.queryByText(LEGACY_HINT)).toBeNull();
  });

  it("无残留文本时正文直接承载格式化错误，error-block 不再重复", async () => {
    const { createAndStreamRun, listConversations, listConversationMessages, listModels } =
      await import("../../shared/sdk/ohna-client");
    vi.mocked(listModels).mockResolvedValue(MODELS);
    vi.mocked(listConversations).mockResolvedValue(listConversationsResult());
    vi.mocked(listConversationMessages).mockResolvedValue(emptyHistory());
    vi.mocked(createAndStreamRun).mockResolvedValue(
      failedResult("internal_error", "connect ECONNREFUSED", { status: 502, cause: "proxy_unreachable" })
    );

    const { container } = await renderAndSubmit("服务没起来");

    expect(await screen.findByText("internal_error: connect ECONNREFUSED (status=502, cause=proxy_unreachable)")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(NEW_HINT)).toBeTruthy());
    expect(container.querySelectorAll(".error-block")).toHaveLength(0);
    expect(screen.queryByText(LEGACY_HINT)).toBeNull();
  });

  it("用户主动取消时不弹 composer 提示，正文保留已生成内容", async () => {
    const { createAndStreamRun, listConversations, listConversationMessages, listModels } =
      await import("../../shared/sdk/ohna-client");
    vi.mocked(listModels).mockResolvedValue(MODELS);
    vi.mocked(listConversations).mockResolvedValue(listConversationsResult());
    vi.mocked(listConversationMessages).mockResolvedValue(emptyHistory());
    vi.mocked(createAndStreamRun).mockImplementation(async (_request, options) => {
      await options?.onAccepted?.(accepted("run-1"));
      options?.onEvent?.(textEvent(1, "取消前的文本"));
      return failedResult("request_cancelled", "Run 已被取消。");
    });

    const { container } = await renderAndSubmit("改一半就好");

    expect(await screen.findByText("取消前的文本")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("cancelled").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(NEW_HINT)).toBeNull();
    expect(screen.queryByText(LEGACY_HINT)).toBeNull();
    expect(container.querySelector(".error-block")?.textContent).toContain("request_cancelled");
  });
});
