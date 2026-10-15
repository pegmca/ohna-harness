import assert from "node:assert/strict";
import test from "node:test";
import { createOrderedRunEventStream, isTerminalRunEvent } from "../dist/application/ordered-run-event-stream.js";

function status(sequence, value = "running") {
  return {
    eventId: `event-${sequence}`, sequence, runId: "run-1", requestId: "request-1",
    conversationId: "conversation-1", createdAt: "2026-07-25T08:00:00.000Z",
    type: "run_status", payload: { status: value, message: value }
  };
}

function terminal(sequence, type = "agent_end") {
  return {
    eventId: `event-${sequence}`, sequence, runId: "run-1", requestId: "request-1",
    conversationId: "conversation-1", createdAt: "2026-07-25T08:00:00.000Z",
    type, payload: type === "agent_end" ? { type: "agent_end", messages: [] } : { error: { code: "internal_error" } }
  };
}

test("catch-up 完成前缓冲高 sequence live event，合并后严格连续且不重复", async () => {
  const written = [];
  let closed = false;
  const stream = createOrderedRunEventStream({
    afterSequence: 0,
    loadAfter: async () => [],
    write: (event) => { written.push(event.sequence); return true; },
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
    write: (event) => { written.push(event.sequence); return true; },
    close: () => undefined
  });

  await stream.replay([status(1)]);
  await stream.completeCatchUp([]);
  await stream.acceptLive(status(3));

  assert.deepEqual(written, [1, 2, 3]);
});

test("agent_end / run_error / interrupted 在 replay 与 live 路径都是关闭 SSE 的终态", async () => {
  assert.equal(isTerminalRunEvent(terminal(1, "agent_end")), true);
  assert.equal(isTerminalRunEvent(terminal(1, "run_error")), true);
  assert.equal(isTerminalRunEvent(status(1, "interrupted")), true);
  assert.equal(isTerminalRunEvent(status(1, "running")), false);

  for (const path of ["replay", "live"]) {
    let closeCount = 0;
    const stream = createOrderedRunEventStream({
      afterSequence: 0,
      loadAfter: async () => [],
      write: () => true,
      close: () => { closeCount += 1; }
    });
    if (path === "replay") {
      await stream.replay([status(1), terminal(2)]);
    } else {
      await stream.replay([status(1)]);
      await stream.completeCatchUp([]);
      await stream.acceptLive(terminal(2));
    }
    assert.equal(stream.isClosed(), true, path);
    assert.equal(closeCount, 1, path);
  }
});

test("write 返回 false 时暂停 drain，resume 后按 sequence 恢复且零丢弃", async () => {
  const written = [];
  let canWrite = false; // 模拟下游背压（Node 流 highWaterMark 满）
  const stream = createOrderedRunEventStream({
    afterSequence: 0,
    loadAfter: async () => [],
    write: (event) => { written.push(event.sequence); return canWrite; },
    close: () => undefined
  });

  // replay 三条事件，第一条 write 返回 false → drain 暂停在 sequence 1 之后
  await stream.replay([status(1), status(2), status(3)]);
  assert.deepEqual(written, [1]); // 背压下只写了第一条

  // 解除背压，resume 恢复 drain
  canWrite = true;
  stream.resume();
  // schedule 是微任务，等一个宏任务
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(written, [1, 2, 3]); // 全部按 sequence 写出，零丢弃
});
