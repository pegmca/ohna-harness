/**
 * W4 TC-W4-01..03：`llm_call` 一等公民展示（摘要、tab 切换、复制 JSON）。
 */
import type { LlmCallRecordDto } from "@aiagent/types";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmCallBlock, formatCost, formatLlmSummary, toJsonText } from "./LlmCallBlock";

const record: LlmCallRecordDto = {
  callId: "call-1",
  callIndex: 2,
  startedAt: 1_700_000_000_000,
  durationMs: 120,
  attemptCount: 2,
  request: {
    provider: "mock",
    api: "openai-completions",
    modelId: "stub-model",
    baseUrl: "http://127.0.0.1/mock",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    tools: [{ name: "read", description: "read file", inputSchema: { type: "object" } }],
    temperature: 0.2,
    maxTokens: 512,
    providerPayload: { model: "stub-model", stream: true, messages: [{ role: "user", content: "hi" }] }
  },
  response: {
    status: 200,
    finishReason: "stop",
    responseId: "resp-1",
    responseModel: "stub-model-2026",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 }
    },
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
  }
};

afterEach(cleanup);

describe("LlmCallBlock", () => {
  it("TC-W4-01: 摘要行格式固定，attemptCount>1 与 error 都有标记", () => {
    expect(formatLlmSummary(record)).toBe(
      "#2 · stub-model · 120ms · in 10 · out 20 · $0.003000"
    );
    const { unmount } = render(<LlmCallBlock record={record} />);
    expect(screen.getByRole("button", { name: formatLlmSummary(record) })).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
    unmount();

    render(<LlmCallBlock record={{ ...record, error: { message: "boom", stopReason: "error" } }} />);
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("TC-W4-02: 展开后可切换请求（两个子 tab）/ 响应 / 原始 JSON", () => {
    render(<LlmCallBlock record={record} />);
    fireEvent.click(screen.getByRole("button", { name: formatLlmSummary(record) }));

    // 请求参数：默认 Provider Payload，可切到统一 messages + tools。
    // BUG-003 后 JSON 走 JsonViewer 树：键与值是分开的高亮节点，不再是一整段平铺文本。
    expect(screen.getByRole("tab", { name: "Provider Payload" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("stream")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "统一 messages + tools" }));
    expect(screen.getByRole("tab", { name: "统一 messages + tools" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("systemPrompt")).toBeTruthy();
    expect(screen.getByText('"sys"')).toBeTruthy();

    // 响应：finishReason / status / responseId / responseModel 与 content blocks。
    fireEvent.click(screen.getByRole("tab", { name: "响应" }));
    expect(screen.getByText(/finishReason: stop/)).toBeTruthy();
    expect(screen.getByText(/responseModel: stub-model-2026/)).toBeTruthy();
    // response.message 是第 1 层对象：默认展开，role 键与 assistant 值直接可见；
    // 但其 content 数组（第 2 层）折叠为摘要，展开后才看到响应文本。
    expect(screen.getByText("role")).toBeTruthy();
    expect(screen.getByText('"assistant"')).toBeTruthy();
    expect(screen.queryByText('"ok"')).toBeNull();
    const contentRow = screen.getByText("content").closest(".json-viewer-row") as HTMLElement;
    fireEvent.click(within(contentRow).getByRole("button", { name: /展开\/收起/ }));
    // content 数组的元素对象仍是第 2 层 → 折叠为摘要。
    const contentItem = screen.getByText("{2 项}").closest(".json-viewer-row") as HTMLElement;
    fireEvent.click(within(contentItem).getByRole("button", { name: /展开\/收起/ }));
    expect(screen.getByText("text")).toBeTruthy();
    expect(screen.getByText('"ok"')).toBeTruthy();

    // 原始 JSON：整条记录（根展开，callId 等标量字段在第 1 层直接可见）。
    fireEvent.click(screen.getByRole("tab", { name: "原始 JSON" }));
    expect(screen.getByText("callId")).toBeTruthy();
    expect(screen.getByText('"call-1"')).toBeTruthy();
    // S1：展开态展示体量（KB + 字符数）。
    expect(screen.getByText(/KB · \d+ 字符/)).toBeTruthy();
  });

  it("BUG-003: 节点级折叠 / 展开，折叠态显示摘要且不渲染子树", () => {
    render(<LlmCallBlock record={record} />);
    fireEvent.click(screen.getByRole("button", { name: formatLlmSummary(record) }));

    // 根对象与第一层 messages 数组都默认展开；数组内的元素对象（第二层）折叠为 `{2 项}` 摘要，
    // 其 role / content 不在 DOM（惰性渲染）。
    expect(screen.getByText("{2 项}")).toBeTruthy();
    expect(screen.queryByText("role")).toBeNull();
    expect(document.body.textContent).not.toContain('"hi"');

    const itemRow = screen.getByText("{2 项}").closest(".json-viewer-row") as HTMLElement;
    const toggle = within(itemRow).getByRole("button", { name: /展开\/收起/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // 展开元素对象：子键与值出现。
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("role")).toBeTruthy();
    expect(screen.getByText('"hi"')).toBeTruthy();

    // 收起元素对象：子树从 DOM 移除，回到摘要态。
    fireEvent.click(toggle);
    expect(screen.queryByText("role")).toBeNull();
    expect(screen.getByText("{2 项}")).toBeTruthy();

    // 折叠 messages 数组本身：摘要回退为 `[1 项]`，元素对象随之消失。
    const messagesRow = screen.getByText("messages").closest(".json-viewer-row") as HTMLElement;
    fireEvent.click(within(messagesRow).getByRole("button", { name: /展开\/收起/ }));
    expect(screen.queryByText("{2 项}")).toBeNull();
    expect(document.body.textContent).not.toContain("role");
    expect(screen.getByText("[1 项]")).toBeTruthy();
  });

  it("TC-W4-03: 复制的内容与当前 tab 的 JSON 序列化一致", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });

    render(<LlmCallBlock record={record} />);
    fireEvent.click(screen.getByRole("button", { name: formatLlmSummary(record) }));
    fireEvent.click(screen.getByRole("button", { name: /复制 JSON/ }));

    expect(writeText).toHaveBeenLastCalledWith(toJsonText(record.request.providerPayload));

    fireEvent.click(screen.getByRole("tab", { name: "原始 JSON" }));
    fireEvent.click(screen.getByRole("button", { name: /复制 JSON/ }));
    expect(writeText).toHaveBeenLastCalledWith(toJsonText(record));
  });

  it("N6: tab 带 aria-controls / tabpanel，并支持左右键切换", () => {
    render(<LlmCallBlock record={record} />);
    fireEvent.click(screen.getByRole("button", { name: formatLlmSummary(record) }));

    const requestTab = screen.getByRole("tab", { name: "请求参数" });
    expect(requestTab.getAttribute("aria-selected")).toBe("true");
    expect(requestTab.getAttribute("aria-controls")).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();

    const tablist = screen.getByRole("tablist", { name: "LLM 记录视图" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "响应" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "请求参数" }).getAttribute("aria-selected")).toBe("true");
  });

  it("N7: 极小成本显示为 <$0.000001，不伪装成免费", () => {
    expect(formatCost(0.0000004)).toBe("<$0.000001");
    expect(formatCost(0.003)).toBe("$0.003000");
  });
});
