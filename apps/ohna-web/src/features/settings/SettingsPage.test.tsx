/**
 * TC-L3-01 / TC-L3-02 / TC-L3-03 · 设置页回归。
 *
 * - 五分区锚点导航 + 内容区渲染；
 * - 主题 / 字号写入 localStorage，并由 `applyInitialTheme` 在挂载前恢复；
 * - 只读边界：设置页只发出 `GET /api/health` 与 `GET /api/models`，不产生任何写请求。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInitialTheme, FONT_SCALE_OPTIONS, ThemeProvider } from "../../app/theme";
import { SettingsPage } from "./SettingsPage";

/**
 * 构造 health 响应。
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
 * 构造模型目录响应。
 *
 * @returns Response。
 */
function modelsResponse(): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: "models",
    data: {
      defaultModelId: "mock",
      models: [{
        id: "mock",
        label: "Mock Agent",
        provider: "mock",
        description: "本地模型 · mock/mock",
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true }
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 渲染设置页（带 ThemeProvider，与 main.tsx 装配一致）。
 *
 * @returns 渲染结果与 fetch mock。
 */
function renderSettings() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/health")) return healthResponse();
    if (url.startsWith("/api/models")) return modelsResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = render(<MemoryRouter><ThemeProvider><SettingsPage /></ThemeProvider></MemoryRouter>);
  return { ...result, fetchMock };
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

// 注意：本文件用到了 `localStorage`，因此**不能**调用 `vi.unstubAllGlobals()`——
// jsdom 的 window 属性是全局 stub，清空会把 localStorage 一起移除；fetch 由各用例自行 stub 覆盖。
afterEach(() => cleanup());

describe("SettingsPage（L3）", () => {
  it("TC-L3-01: 五分区导航与内容区渲染", async () => {
    renderSettings();
    const nav = screen.getByRole("navigation", { name: "设置分区" });
    const links = nav.querySelectorAll("a");
    expect([...links].map((link) => link.textContent)).toEqual([
      "连接状态本地服务地址与工作区",
      "外观主题与界面字号",
      "模型当前进程的模型目录",
      "权限模式只读与自动批准语义",
      "关于版本与项目链接"
    ]);
    expect([...links].map((link) => link.getAttribute("href"))).toEqual([
      "#settings-connection",
      "#settings-appearance",
      "#settings-models",
      "#settings-permission",
      "#settings-about"
    ]);
    // 五个分区标题齐全。
    for (const title of ["连接状态", "外观", "模型", "权限模式", "关于"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // 连接状态分区承载 health 事实。
    expect(await screen.findByText("已连接")).toBeTruthy();
    expect(screen.getByText("/work/ws-a")).toBeTruthy();
    expect(screen.getByText("/tmp/ohna")).toBeTruthy();
    // 模型分区渲染只读目录。
    expect(await screen.findByText("Mock Agent")).toBeTruthy();
    expect(screen.getByText("tool calling")).toBeTruthy();
    expect(screen.getByText("版本与运行环境信息。")).toBeTruthy();
  });

  it("顶部展示适用范围说明行", () => {
    renderSettings();
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeTruthy();
    expect(screen.getByText("适用于当前 ohna 进程 · 由启动参数决定")).toBeTruthy();
  });

  it("TC-L3-02: 主题切换写入 localStorage 并立即生效", () => {
    renderSettings();
    const dark = screen.getByRole("radio", { name: /深色/ });
    fireEvent.click(dark);
    expect(globalThis.localStorage.getItem("ohna.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /浅色/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("TC-L3-02: 字号切换写入 localStorage、缩放根字号", () => {
    renderSettings();
    const large = screen.getByRole("radio", { name: /^大/ });
    fireEvent.click(large);
    expect(globalThis.localStorage.getItem("ohna.ui.fontSize")).toBe("large");
    expect(document.documentElement.style.fontSize).toBe("112.5%");
    expect(large.getAttribute("aria-checked")).toBe("true");
  });

  it("TC-L3-02: 挂载前恢复存储的主题与字号（防闪烁）", () => {
    globalThis.localStorage.setItem("ohna.theme", "light");
    globalThis.localStorage.setItem("ohna.ui.fontSize", "xlarge");
    applyInitialTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.fontSize).toBe("125%");

    // 非法字号回落标准档。
    globalThis.localStorage.setItem("ohna.ui.fontSize", "huge");
    applyInitialTheme();
    expect(document.documentElement.style.fontSize).toBe("100%");
  });

  it("TC-L3-02: 四档字号元数据完整（小 / 标准 / 大 / 特大）", () => {
    expect(FONT_SCALE_OPTIONS.map((option) => option.label)).toEqual(["小", "标准", "大", "特大"]);
    renderSettings();
    expect(screen.getAllByRole("radio", { name: /^标准/ })).toHaveLength(1);
  });

  it("TC-L3-03: 只读边界——只发 GET /api/health 与 GET /api/models，无任何写请求", async () => {
    const { fetchMock } = renderSettings();
    await waitFor(() => expect(screen.getByText("/work/ws-a")).toBeTruthy());
    await screen.findByText("Mock Agent");

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method ?? "GET"
    }));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => call.url.startsWith("/api/health") || call.url.startsWith("/api/models"))).toBe(true);
    // 点击主题/字号不产生网络请求。
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: /深色/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^大/ }));
    expect(fetchMock.mock.calls.length).toBe(before);
    // 页面上没有可用于提交服务端配置的输入控件。
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });

  it("本地服务不可用时各分区降级为可读提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    render(<MemoryRouter><ThemeProvider><SettingsPage /></ThemeProvider></MemoryRouter>);
    expect(await screen.findByText(/未检测到本地 ohna 服务/)).toBeTruthy();
    expect(screen.getByText("本地服务不可用，无法读取当前权限模式。")).toBeTruthy();
  });
});
