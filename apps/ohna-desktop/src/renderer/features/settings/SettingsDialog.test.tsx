/**
 * TC-L3-01 / TC-L3-02 / TC-L3-03 / TC-FR-001 · 设置弹窗回归（原 `SettingsPage.test.tsx` 迁移）。
 *
 * FR-001 把设置从独立路由页改为 chat 页左下角入口触发的就地弹窗，因此这里除保留
 * 「分区渲染 / 外观持久化 / 只读边界」三组原断言外，还补齐弹窗语义：
 * - 打开渲染、关闭按钮 / 遮罩 / ESC 三种关闭方式；
 * - 关闭即卸载内容（健康探针随之中止，再次打开才重新请求）；
 * - 打开时焦点移入对话框、关闭后归还给触发按钮。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInitialTheme, FONT_SCALE_OPTIONS, ThemeProvider } from "../../app/theme";
import { SettingsDialog } from "./SettingsDialog";
import * as client from "../../shared/sdk/ohna-client";

vi.mock("../../shared/sdk/ohna-client");

const mocked = vi.mocked(client);

/**
 * 安装 preload SDK 的 health 返回值。
 *
 * @returns health mock。
 */
function healthResult() {
  return {
    ok: true as const,
    requestId: "health",
    data: {
      status: "ok" as const,
      protocolVersion: 1,
      modelCount: 19,
      workspaceCount: 2
    }
  };
}

/**
 * 模拟左侧角落的设置入口 + 弹窗组合：触发按钮保留在页面上，用于验证焦点归还与开关。
 *
 * 模型目录经 preload SDK（`shared/sdk/ohna-client` 的 `listModels`）读取，不在此处走 HTTP。
 *
 * @param props.isInitiallyOpen 初始是否展开（默认展开，多数用例直接断言内容）。
 * @returns 组合组件。
 */
function SettingsHarness(props: { isInitiallyOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(props.isInitiallyOpen ?? true);
  return (
    <>
      <button onClick={() => setIsOpen(true)} type="button">设置</button>
      <SettingsDialog isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}

/**
 * 渲染弹窗（带 ThemeProvider，与 main.tsx 装配一致）。
 *
 * @param options.isInitiallyOpen 初始是否展开。
 * @returns 渲染结果与 fetch mock。
 */
function renderDialog(options: { isInitiallyOpen?: boolean } = {}) {
  mocked.getRuntimeHealth.mockResolvedValue(healthResult());
  mocked.listModels.mockResolvedValue({
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
  });
  mocked.loadUserSettings.mockResolvedValue({
    ok: true,
    requestId: "settings",
    data: {
      defaultProfile: "bridge_ai",
      providers: {
        bridge_ai: {
          baseUrl: "http://192.168.5.8:8787/v1",
          model: "hy3-x",
          models: ["hy3", "hy3-x"],
          apiKey: "secret"
        }
      },
      httpProxy: "http://127.0.0.1:1082"
    }
  });
  mocked.saveUserSettings.mockResolvedValue({ ok: true, requestId: "save", data: { path: "/tmp/settings.json" } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = render(
    <ThemeProvider>
      <SettingsHarness isInitiallyOpen={options.isInitiallyOpen} />
    </ThemeProvider>
  );
  return { ...result, fetchMock };
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

// 注意：本文件用到了 `localStorage`，因此**不能**调用 `vi.unstubAllGlobals()`——
// jsdom 的 window 属性是全局 stub，清空会把 localStorage 一起移除；fetch 由各用例自行 stub 覆盖。
afterEach(() => cleanup());

describe("SettingsDialog（L3 / FR-001）", () => {
  it("TC-L3-01: 弹窗内五分区导航与内容区渲染", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "设置分区" });
    const links = nav.querySelectorAll("a");
    expect([...links].map((link) => link.textContent)).toEqual([
      "连接状态runtime 与工作区",
      "外观主题与界面字号",
      "模型用户配置与模型",
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
    expect(screen.getByText("19")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    // 模型分区读取用户 settings，并渲染可编辑表单。
    expect(await screen.findByDisplayValue("http://192.168.5.8:8787/v1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeTruthy();
    expect(screen.getByText("应用版本")).toBeTruthy();
    expect(screen.getByText("版本与运行环境信息。")).toBeTruthy();
  });

  it("弹窗头部展示标题与适用范围说明", () => {
    renderDialog();
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeTruthy();
    expect(screen.getByText("适用于当前 ohna 进程 · 由启动参数决定")).toBeTruthy();
  });

  it("TC-FR-001: 未打开时不渲染任何弹窗内容", () => {
    renderDialog({ isInitiallyOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    // 关闭态不渲染分区导航 —— 设置不再是常驻页面。
    expect(screen.queryByRole("navigation", { name: "设置分区" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
  });

  it("TC-FR-001: 点击左下角入口打开、关闭按钮关闭", async () => {
    const { fetchMock } = renderDialog({ isInitiallyOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(await screen.findByText("已连接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // 关闭后弹窗内容卸载，不会继续渲染结果。
    expect(screen.queryByText("已连接")).toBeNull();
    expect(mocked.getRuntimeHealth).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TC-FR-001: ESC 与点击遮罩都能关闭弹窗", () => {
    renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop.className).toContain("settings-dialog-backdrop");
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("TC-FR-001: 关闭时卸载内容，健康探针随之中止，再次打开重新请求", async () => {
    renderDialog();
    await screen.findByText("已连接");
    expect(mocked.getRuntimeHealth).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByText("已连接")).toBeNull();

    const callsBeforeReopen = mocked.getRuntimeHealth.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByText("已连接");
    expect(mocked.getRuntimeHealth.mock.calls.length).toBeGreaterThan(callsBeforeReopen);
  });

  it("TC-FR-001: 打开时焦点进入对话框，关闭后归还给入口按钮", () => {
    renderDialog({ isInitiallyOpen: false });
    const entry = screen.getByRole("button", { name: "设置" });
    entry.focus();
    fireEvent.click(entry);
    // 焦点落到 dialog 容器（role=dialog, tabIndex=-1），屏幕阅读器先读标题。
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "设置" }));

    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(document.activeElement).toBe(entry);
  });

});

describe("SettingsDialog 外观与只读边界（L3）", () => {
  it("TC-L3-02: 主题切换写入 localStorage 并立即生效", () => {
    renderDialog();
    const dark = screen.getByRole("radio", { name: /深色/ });
    fireEvent.click(dark);
    expect(globalThis.localStorage.getItem("ohna.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /浅色/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("TC-L3-02: 字号切换写入 localStorage、缩放根字号", () => {
    renderDialog();
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
    renderDialog();
    expect(screen.getAllByRole("radio", { name: /^标准/ })).toHaveLength(1);
  });

  it("TC-L3-03: 外观偏好只写 localStorage，设置全程经 preload 读写", async () => {
    const { fetchMock } = renderDialog();
    await waitFor(() => expect(mocked.getRuntimeHealth).toHaveBeenCalled());
    await screen.findByDisplayValue("http://192.168.5.8:8787/v1");

    // 桌面包边界：健康、模型、配置均经 preload SDK，不假设存在 HTTP 服务。
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method ?? "GET"
    }));
    expect(calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    // 点击主题/字号不产生网络请求。
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: /深色/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^大/ }));
    expect(fetchMock.mock.calls.length).toBe(before);
    // 模型配置保存在 ~/.ohna/settings.json：表单存在，但保存不走 HTTP。
    const beforeSaveHttp = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(mocked.saveUserSettings).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.length).toBe(beforeSaveHttp);
  });

  it("runtime 不可用时各分区降级为可读提示", async () => {
    mocked.getRuntimeHealth.mockRejectedValue(new Error("runtime unavailable"));
    render(<ThemeProvider><SettingsHarness /></ThemeProvider>);
    expect(await screen.findByText(/runtime 不可用/)).toBeTruthy();
    expect(screen.getByText("runtime 不可用，无法读取当前权限模式。")).toBeTruthy();
  });
});
