import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("IdentityProvider", () => {
  it("renders the workbench while identity verification is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { IdentityProvider } = await import("./identity");
    render(
      <IdentityProvider>
        <div>工作台已渲染</div>
      </IdentityProvider>,
    );

    expect(screen.getByText("工作台已渲染")).toBeTruthy();
    expect(screen.queryByText("正在识别当前浏览器")).toBeNull();
  });

  it("uses the saved identity snapshot before the background session check finishes", async () => {
    window.localStorage.setItem(
      "immersive.identitySnapshot",
      JSON.stringify({
        userId: "user_cached",
        createdAt: "2026-10-30T00:00:00.000Z",
        qqBot: { enabled: false, status: "disabled" },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { IdentityProvider, useIdentity } = await import("./identity");

    /** @returns 当前身份快照。 */
    function IdentityProbe() {
      return <span>{useIdentity().identity?.userId ?? "missing"}</span>;
    }

    render(
      <IdentityProvider>
        <IdentityProbe />
      </IdentityProvider>,
    );
    expect(screen.getByText("user_cached")).toBeTruthy();
  });

  it("blocks the workbench when background identity verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const { IdentityProvider } = await import("./identity");
    render(
      <IdentityProvider>
        <div>工作台已渲染</div>
      </IdentityProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "浏览器身份初始化失败" }),
    ).toBeTruthy();
    expect(screen.queryByText("工作台已渲染")).toBeNull();
  });
});
