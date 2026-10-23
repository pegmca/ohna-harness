/**
 * TC-FR-001 · Workbench 与设置弹窗的集成（05 FR-001）。
 *
 * 设置从独立 `/settings` 路由页改为左侧会话栏底部的就地弹窗：
 * - 左侧会话栏底部有「设置」入口，点击弹出 `role="dialog"`；
 * - 顶部导航不再有「设置」tab（导航只保留「对话」）；
 * - 弹窗打开时才发健康探针，关闭即卸载内容。
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../app/theme";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * 构造 health 响应（设置弹窗「连接状态」分区数据源）。
 *
 * @returns Response。
 */
function healthResponse(): Response {
  return new Response(JSON.stringify({
    mode: "local",
    workspaceRoot: "/work/ws-a",
    model: { id: "mock", provider: "mock" },
    pid: 4242,
    dataDir: "/tmp/ohna"
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 渲染 Workbench（与 main.tsx 装配一致：ThemeProvider 在外层，设置弹窗复用其偏好上下文）。
 *
 * @returns fetch mock。
 */
function renderWorkbench() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/conversations?")) {
      return new Response(JSON.stringify({ ok: true, requestId: "list", data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("/api/health")) return healthResponse();
    // 其余端点（模型目录由 mock 提供）不应在测试里被触达。
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<MemoryRouter><ThemeProvider><Workbench /></ThemeProvider></MemoryRouter>);
  return fetchMock;
}

describe("Workbench 设置入口（FR-001）", () => {
  it("左侧会话栏底部设置按钮打开弹窗，关闭按钮收起", () => {
    const fetchMock = renderWorkbench();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("navigation", { name: "设置分区" })).toBeTruthy();
    // 打开后才发出健康探针。
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/health"))).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("顶部导航不再有「设置」tab，只保留「对话」", () => {
    renderWorkbench();
    const nav = screen.getByRole("navigation", { name: "工作台导航" });
    const tabs = [...nav.querySelectorAll(".app-nav-tab")].map((tab) => tab.textContent);
    // TraceToggle 也是 app-nav-tab（历史沿用），但不存在「设置」tab，也没有 /settings 链接。
    expect(tabs).not.toContain("设置");
    expect(tabs).toContain("对话");
    expect(nav.querySelector('a[href="/settings"]')).toBeNull();
  });
});
