import { describe, expect, it } from "vitest";
import { formatApiError, parseApiResult } from "./http-client";

describe("parseApiResult", () => {
  it("returns the typed JSON envelope", async () => {
    const response = new Response(JSON.stringify({ ok: true, requestId: "req_1", data: { value: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    await expect(parseApiResult<{ value: number }>(response)).resolves.toEqual({
      ok: true,
      requestId: "req_1",
      data: { value: 1 }
    });
  });

  it("maps an empty proxy response to a structured error", async () => {
    const result = await parseApiResult(new Response("", { status: 502 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.status).toBe(502);
  });
});

describe("formatApiError", () => {
  it("only includes approved diagnostics", () => {
    expect(formatApiError({
      code: "internal_error",
      message: "失败",
      requestId: "req_1",
      details: { status: 500, secret: "hidden" }
    })).toBe("internal_error: 失败 (status=500)");
  });
});
