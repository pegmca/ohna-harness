import assert from "node:assert/strict";
import test from "node:test";
import { createOrderedRunEventStream, isTerminalRunEvent } from "../dist/application/ordered-run-event-stream.js";

function status(sequence, value = "running") {
  return {
    eventId: `event-${sequence}`, sequence, runId: "run-1", requestId: "request-1",
    traceId: "trace-1", conversationId: "conversation-1", createdAt: "2026-07-25T08:00:00.000Z",
    type: "run_status", status: value, message: value
  };
}

test("catch-up 完成前缓冲高 sequence live event，合并后严格连续且不重复", async () => {
  const written = [];
  let closed = false;
  const stream = createOrderedRunEventStream({
    afterSequence: 0,
    loadAfter: async () => [],
    write: (event) => written.push(event.sequence),
    close: () => { closed = true; }
  });

  await stream.replay([status(1)]);
  const earlyLive = stream.acceptLive(status(3));
  await stream.completeCatchUp([status(2), status(3)]);
  await earlyLive;

  assert.deepEqual(written, [1, 2, 3]);
  assert.equal(new Set(written).size, written.length);
  assert.equal(closed, false);
});

test("直接 live 观察到缺口时从数据库补齐后再发送高 sequence", async () => {
  const written = [];
  const stream = createOrderedRunEventStream({
    afterSequence: 0,
    loadAfter: async (sequence) => sequence === 1 ? [status(2), status(3)] : [],
    write: (event) => written.push(event.sequence),
    close: () => undefined
  });

  await stream.replay([status(1)]);
  await stream.completeCatchUp([]);
  await stream.acceptLive(status(3));

  assert.deepEqual(written, [1, 2, 3]);
});

test("cancelled 在 replay 与 live 路径都是关闭 SSE 的 canonical 终态", async () => {
  assert.equal(isTerminalRunEvent(status(1, "cancelled")), true);

  for (const path of ["replay", "live"]) {
    let closeCount = 0;
    const stream = createOrderedRunEventStream({
      afterSequence: 0,
      loadAfter: async () => [],
      write: () => undefined,
      close: () => { closeCount += 1; }
    });
    if (path === "replay") {
      await stream.replay([status(1, "cancelled")]);
    } else {
      await stream.replay([]);
      await stream.completeCatchUp([]);
      await stream.acceptLive(status(1, "cancelled"));
    }
    assert.equal(stream.isClosed(), true, path);
    assert.equal(closeCount, 1, path);
  }
});
