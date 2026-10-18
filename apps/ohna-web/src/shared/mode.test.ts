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
});
