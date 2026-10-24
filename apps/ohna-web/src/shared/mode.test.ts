import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLocalMode } from "./mode";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLocalMode", () => {
  it("parses the flat health payload into local mode info", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "local",
      workspaceRoot: "/tmp/ohna-ws",
      model: { id: "deepseek-chat", provider: "deepseek" },
      pid: 123,
      dataDir: "/Users/me/.ohna"
    }), { status: 200 })));

    await expect(fetchLocalMode()).resolves.toEqual({
      workspaceRoot: "/tmp/ohna-ws",
      modelId: "deepseek-chat",
      dataDir: "/Users/me/.ohna"
    });
  });

  it("degrades to null when the server reports a non-local mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mode: "saas" }), { status: 200 })));
    await expect(fetchLocalMode()).resolves.toBeNull();
  });

  it("degrades to null on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
    await expect(fetchLocalMode()).resolves.toBeNull();
  });

  it("degrades to null when fetch throws (proxy down)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchLocalMode()).resolves.toBeNull();
  });

  it("parses observeOnly:true from a read-only observation instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "local",
      workspaceRoot: "/tmp/ohna-ws",
      observeOnly: true
    }), { status: 200 })));

    await expect(fetchLocalMode()).resolves.toEqual({
      workspaceRoot: "/tmp/ohna-ws",
      observeOnly: true
    });
  });

  it("parses observeOnly:false from an interactive single-form instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "local",
      workspaceRoot: "/tmp/ohna-ws",
      observeOnly: false
    }), { status: 200 })));

    await expect(fetchLocalMode()).resolves.toEqual({
      workspaceRoot: "/tmp/ohna-ws",
      observeOnly: false
    });
  });

  it("omits observeOnly when the field is absent (treated as interactive)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "local",
      workspaceRoot: "/tmp/ohna-ws"
    }), { status: 200 })));

    // 旧实例 / 未透出该字段时不应误判为只读，避免把可交互实例错误禁用 composer。
    await expect(fetchLocalMode()).resolves.toEqual({ workspaceRoot: "/tmp/ohna-ws" });
  });
});
