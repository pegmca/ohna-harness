import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeHost } from "../dist/main/runtime-host.js";
import { PROTOCOL_VERSION } from "@aiagent/types";

/**
 * 内存传输桩：允许测试直接推送事件，模拟 worker 的 replay + live 事件流。
 */
function createTransport() {
  let eventCb;
  return {
    started: false,
    async start() {
      this.started = true;
    },
    postRequest() {
      // 订阅类请求在测试中由调用方直接 emit 事件，不模拟响应。
    },
    onResponse() {},
    onEvent(cb) {
      eventCb = cb;
    },
    onCrash() {},
    async stop() {},
    emit(subscriptionId, type) {
      eventCb?.({
        protocolVersion: PROTOCOL_VERSION,
        subscriptionId,
        event: { type, requestId: "r", conversationId: "c", runId: "run" }
      });
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("订阅预登记后，连续 replay 事件全部按序投递且 draining 可复位", async () => {
  const transport = createTransport();
  const host = new RuntimeHost({ createTransport: () => transport });
  await host.start();

  const received = [];
  host.subscribe("sub-pre", (event) => received.push(event.type));

  for (const type of [
    "user_message",
    "agent_start",
    "llm_call",
    "turn_start",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
    "cost_summary",
    "run_status"
  ]) {
    transport.emit("sub-pre", type);
  }

  await flush();
  await flush();

  assert.deepEqual(received, [
    "user_message",
    "agent_start",
    "llm_call",
    "turn_start",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
    "cost_summary",
    "run_status"
  ]);
});

test("排空后新事件仍能触发下一次投递", async () => {
  const transport = createTransport();
  const host = new RuntimeHost({ createTransport: () => transport });
  await host.start();

  const received = [];
  host.subscribe("sub-r", (event) => received.push(event.type));
  transport.emit("sub-r", "first");
  await flush();
  await flush();
  transport.emit("sub-r", "second");
  await flush();
  await flush();

  assert.deepEqual(received, ["first", "second"]);
});
