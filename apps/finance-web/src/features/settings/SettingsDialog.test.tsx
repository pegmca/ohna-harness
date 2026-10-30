import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityProvider } from "../../app/identity";
import { ThemeProvider } from "../../app/theme";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 渲染带主题与身份上下文的设置弹窗；身份接口返回稳定的只读 fixture。
 *
 * @returns 渲染结果与 fetch mock。
 */
function renderDialog() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          requestId: "identity",
          data: {
            userId: "user_settings_test",
            createdAt: "2026-10-30T00:00:00.000Z",
            qqBot: { enabled: false, status: "disabled" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ThemeProvider>
      <IdentityProvider>
        <SettingsDialog isOpen onClose={vi.fn()} />
      </IdentityProvider>
    </ThemeProvider>,
  );
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("finance SettingsDialog", () => {
  it("shows placeholders instead of throwing while identity is still being verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <ThemeProvider>
        <IdentityProvider>
          <SettingsDialog isOpen onClose={vi.fn()} />
        </IdentityProvider>
      </ThemeProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(dialog).toBeTruthy();
    expect(screen.getAllByText("正在校验身份…").length).toBeGreaterThan(0);
    expect(screen.getByText("正在读取…")).toBeTruthy();
  });

  it("renders the finance-only sections in a dialog", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "设置分区" })).toBeTruthy();
    expect(await screen.findByText("user_settings_test")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "外观" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "账户与连接" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "关于" }),
    ).toBeTruthy();
  });

  it("persists theme and font scale without server writes", () => {
    renderDialog();
    return waitFor(async () => {
      const dialog = await screen.findByRole("dialog", { name: "设置" });
      const callsBefore = vi.mocked(fetch).mock.calls.length;
      fireEvent.click(screen.getByRole("radio", { name: /^深色/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^大/ }));
      expect(window.localStorage.getItem("immersive.theme")).toBe("dark");
      expect(window.localStorage.getItem("immersive.ui.fontSize")).toBe(
        "large",
      );
      expect(document.documentElement.style.fontSize).toBe("112.5%");
      expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
      expect(dialog).toBeTruthy();
    });
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              requestId: "identity",
              data: {
                userId: "user_settings_test",
                createdAt: "2026-10-30T00:00:00.000Z",
                qqBot: { enabled: false, status: "disabled" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(
      <ThemeProvider>
        <IdentityProvider>
          <SettingsDialog isOpen onClose={onClose} />
        </IdentityProvider>
      </ThemeProvider>,
    );
    return waitFor(() => {
      expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
