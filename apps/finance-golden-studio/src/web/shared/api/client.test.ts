import assert from "node:assert/strict";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGoldenStudioClient } from "./client.ts";
import type { ApiEnvelope } from "./types.ts";

/**
 * 构造一个可注入的 JSON 响应。
 *
 * @param body 响应体。
 * @param init 额外的 Response 选项。
 * @returns 测试用 Response。
 */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createGoldenStudioClient", () => {
  test("listBatches unwraps the ok envelope and requests the batches route", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: [
          {
            name: "batch-01",
            draftCount: 2,
            approvedCount: 1,
            pendingCount: 1,
            corruptCount: 0
          }
        ]
      } satisfies ApiEnvelope<unknown>)
    );
    vi.stubGlobal("fetch", fetch);

    const client = createGoldenStudioClient("http://127.0.0.1:4318/");
    const batches = await client.listBatches({ signal: AbortSignal.timeout(100) });

    assert.equal(batches[0]?.name, "batch-01");
    expect(fetch).toHaveBeenCalledWith(
      new URL("api/batches", "http://127.0.0.1:4318/"),
      expect.objectContaining({ method: "GET", signal: expect.anything() })
    );
  });

  test("structured server errors are surfaced as ApiError with code and details", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            status: 409,
            code: "draft_corrupt",
            message: "The draft file is not valid JSONL.",
            details: { filePath: "x/y.jsonl" }
          }
        },
        { status: 409 }
      )
    );
    vi.stubGlobal("fetch", fetch);

    const client = createGoldenStudioClient("/api-base/");
    const error = await client.readDraft("batch-01", "fin-D001").catch((value) => value);

    assert.ok(error instanceof Error);
    assert.equal(error.name, "ApiError");
    assert.equal((error as { code?: string }).code, "draft_corrupt");
    assert.equal((error as { status?: number }).status, 409);
    assert.deepEqual((error as { details?: unknown }).details, {
      filePath: "x/y.jsonl"
    });
    assert.match(error.message, /draft_corrupt/);
  });

  test("network failures become structured ApiError transport errors", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetch);

    const client = createGoldenStudioClient("/api");
    const error = await client.listBatches().catch((value) => value);

    assert.equal(error.name, "ApiError");
    assert.equal((error as { code?: string }).code, "network_error");
    assert.match(error.message, /connection refused/);
  });

  test("saveDraft PUTs the draft payload and unwraps the saved draft", async () => {
    const savedDraft = { id: "fin-D001" };
    const fetch = vi.fn(async () => jsonResponse({ ok: true, data: savedDraft }));
    vi.stubGlobal("fetch", fetch);

    const client = createGoldenStudioClient("/");
    const result = await client.saveDraft("batch-01", "fin-D001", savedDraft as never);

    assert.deepEqual(result, savedDraft);
    const firstCall = fetch.mock.calls[0] as unknown as
      | [URL, RequestInit]
      | undefined;
    if (!firstCall) throw new Error("Expected saveDraft to issue one request.");
    const [url, init] = firstCall;
    assert.equal(url?.toString().endsWith("/api/batches/batch-01/drafts/fin-D001"), true);
    assert.equal((init as RequestInit).method, "PUT");
    assert.equal(
      ((init as RequestInit).headers as Record<string, string>)["content-type"],
      "application/json"
    );
  });
});
