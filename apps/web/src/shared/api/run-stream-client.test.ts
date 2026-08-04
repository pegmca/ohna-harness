import type { AgentRunAcceptedDto } from "@aiagent/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndStreamRun } from "./run-stream-client";

/**
 * run-stream-client 传输层行为（PR #16 review 问题 2）：
 * 真实断网（reader.read reject）必须走 afterSequence 续传，而不是直接把 run 判 failed。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const accepted: AgentRunAcceptedDto = {
  runId: "run-1",
  requestId: "request-1",
  conversationId: "c1",
  modelId: "mock",
  status: "queued",
  eventsUrl: "/api/runs/run-1/events",
  snapshotUrl: "/api/runs/run-1"
};

describe("createAndStreamRun reconnection", () => {
  it("reconnects with afterSequence when the stream breaks with a transport error", async () => {
    const requestedUrls: string[] = [];
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/runs") return json(accepted);
      if (url === "/api/runs/run-1/events") {
        // 第一段流：给一帧后模拟真实断网（非 AbortError 的传输异常）。
        return breakingStream(sseFrame(1, "run_status", { status: "running", message: "检索中" }));
      }
      if (url.includes("afterSequence=1")) {
        return sseResponse([
          sseFrame(2, "message_update", {
            message: { role: "assistant", content: [{ type: "text", text: "完成" }] },
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "完成" }] } }
          }),
          sseFrame(3, "agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "完成" }] }] })
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const result = await createAndStreamRun(
      { message: "问题", conversationId: "c1", modelId: "mock", mode: "auto", source: "composer" },
      { onEvent: (event) => events.push(event.type) }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("completed");
    // 第二次 events 请求必须携带 afterSequence 续传，而不是直接判失败。
    expect(requestedUrls.filter((url) => url.includes("/events"))).toHaveLength(2);
    expect(requestedUrls[2]).toContain("afterSequence=1");
    expect(events).toEqual(["run_status", "message_update", "agent_end"]);
  });

  it("skips malformed frames and accepts the no-space event field form", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/runs") return json(accepted);
      if (url.includes("/events")) {
        const good = sseFrame(2, "agent_end", { messages: [] });
        // 畸形 JSON 帧 + `event:run_event`（冒号后无空格，SSE 规范允许）。
        const body = `id: 1\nevent: run_event\ndata: {not json\n\n${good.replace("event: run_event", "event:run_event")}\n\n`;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const result = await createAndStreamRun(
      { message: "问题", conversationId: "c1", modelId: "mock", mode: "auto", source: "composer" }
    );
    expect(result.ok).toBe(true);
  });

  it("propagates AbortError instead of reconnecting when the user stops", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/runs") return json(accepted);
      if (url.includes("/events")) {
        controller.abort();
        return breakingStream("");
      }
      if (url.includes("/api/runs/run-1")) {
        return json({
          ...accepted,
          mode: "auto",
          source: "composer",
          status: "cancelled",
          lastEventSequence: 0,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:01.000Z"
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const result = await createAndStreamRun(
      { message: "问题", conversationId: "c1", modelId: "mock", mode: "auto", source: "composer" },
      { signal: controller.signal }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("request_cancelled");
  });
});

/** @param data DTO。 @returns JSON API 成功响应。 */
function json(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, requestId: "test", data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** @param frames SSE 帧。 @returns 完整事件流响应。 */
function sseResponse(frames: string[]): Response {
  return new Response(`${frames.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** @param prefix 先投递的流内容。 @returns 投递后立刻以传输异常中断的流响应。 */
function breakingStream(prefix: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      if (prefix) streamController.enqueue(encoder.encode(`${prefix}\n\n`));
    },
    pull(streamController) {
      // 首个 chunk 被消费后才报错，模拟「读到一半断网」。
      streamController.error(new TypeError("network connection lost"));
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** @param sequence 序号。 @param type 事件类型。 @param payload 事件本体。 @returns 完整 SSE 帧文本。 */
function sseFrame(sequence: number, type: string, payload: unknown): string {
  const envelope = {
    eventId: `event-${sequence}`,
    runId: "run-1",
    requestId: "request-1",
    conversationId: "c1",
    sequence,
    type,
    payload,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
  return `id: ${sequence}\nevent: run_event\ndata: ${JSON.stringify(envelope)}`;
}
