import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRunEventBus } from "../dist/adapters/redis-run-event-bus.js";

/**
 * 内存版共享频道总线，模拟 Redis pub/sub 的语义：
 * - 任一 transport 的 publish 会投递给**所有**订阅了该频道的 transport（含发布者自身），
 *   用来真实复现「self-echo」场景，验证 instanceId 去重。
 * - 不持久化：订阅前的消息不补发（与 redis pub/sub 一致；SSE 侧由 completeCatchUp 查库兜底）。
 */
class SharedBus {
  constructor() {
    /** @type {Map<string, Set<import("../dist/adapters/redis-run-event-bus.js").default>>} */
    this.channels = new Map();
  }

  add(channel, transport) {
    const set = this.channels.get(channel) ?? new Set();
    set.add(transport);
    this.channels.set(channel, set);
  }

  remove(channel, transport) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(transport);
    if (set.size === 0) this.channels.delete(channel);
  }

  publish(channel, message) {
    const set = this.channels.get(channel);
    if (!set) return;
    // 复制一份，避免投递过程中集合被修改导致迭代异常。
    for (const transport of [...set]) transport._deliver(channel, message);
  }
}

function createMockTransport(shared) {
  let handler = undefined;
  const subscribed = new Set();
  const transport = {
    async publish(channel, message) {
      shared.publish(channel, message);
    },
    async subscribe(channel) {
      if (subscribed.has(channel)) return;
      subscribed.add(channel);
      shared.add(channel, transport);
    },
    async unsubscribe(channel) {
      if (!subscribed.has(channel)) return;
      subscribed.delete(channel);
      shared.remove(channel, transport);
    },
    onMessage(fn) {
      handler = fn;
    },
    async quit() {},
    _deliver(channel, message) {
      handler?.(channel, message);
    },
    /** 测试探针：当前已订阅频道集合。 */
    subscribedChannels() {
      return [...subscribed];
    }
  };
  return transport;
}

/** 构造一条最小 RunStreamEvent，供 publish/subscribe 断言。 */
function event(runId, seq) {
  return {
    eventId: `e-${seq}`, sequence: seq, runId, requestId: "req-1",
    conversationId: "conv-1", createdAt: "2026-07-25T08:00:00.000Z",
    type: "run_status", payload: { status: "running", message: "hi" }
  };
}

/** 等待总线内部异步订阅（transport.subscribe 为 await）落定。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("跨实例 fan-out：实例 A 发布，落到实例 B 的 SSE 订阅者", async () => {
  const shared = new SharedBus();
  const busA = createRedisRunEventBus(createMockTransport(shared));
  const busB = createRedisRunEventBus(createMockTransport(shared));
  const received = [];
  busB.subscribe("run-1", (e) => received.push(e));
  await tick();
  busA.publish(event("run-1", 1));
  await tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].sequence, 1);
});

test("同实例直投 + 回声去重：发布者自身订阅者只收到一次", async () => {
  const shared = new SharedBus();
  const busA = createRedisRunEventBus(createMockTransport(shared));
  const received = [];
  busA.subscribe("run-1", (e) => received.push(e));
  await tick();
  // 发布者既走本地直投，又会经 shared 总线收到自家回声；instanceId 去重后应只投一次。
  busA.publish(event("run-1", 2));
  await tick();
  assert.equal(received.length, 1);
});

test("两个实例各自有订阅者时，每侧各收一次、互不翻倍", async () => {
  const shared = new SharedBus();
  const busA = createRedisRunEventBus(createMockTransport(shared));
  const busB = createRedisRunEventBus(createMockTransport(shared));
  const a = [];
  const b = [];
  busA.subscribe("run-1", (e) => a.push(e));
  busB.subscribe("run-1", (e) => b.push(e));
  await tick();
  busA.publish(event("run-1", 3));
  await tick();
  assert.equal(a.length, 1, "A 侧应恰好收到一次（本地直投，回声被丢弃）");
  assert.equal(b.length, 1, "B 侧应恰好收到一次（跨实例广播）");
});

test("退订：最后一个监听者离开后频道退订，后续事件不再投递", async () => {
  const shared = new SharedBus();
  const transportB = createMockTransport(shared);
  const busB = createRedisRunEventBus(transportB);
  const received = [];
  const unsub = busB.subscribe("run-1", (e) => received.push(e));
  await tick();
  assert.ok(transportB.subscribedChannels().includes("aiagent:run_events:run-1"));
  unsub();
  await tick();
  assert.ok(!transportB.subscribedChannels().includes("aiagent:run_events:run-1"));
  // 再发一条，已退订不应收到。
  const busA = createRedisRunEventBus(createMockTransport(shared));
  busA.publish(event("run-1", 4));
  await tick();
  assert.equal(received.length, 0);
});

test("跨实例投递：频道按 runId 隔离，不串台", async () => {
  const shared = new SharedBus();
  const busA = createRedisRunEventBus(createMockTransport(shared));
  const busB = createRedisRunEventBus(createMockTransport(shared));
  const run1 = [];
  const run2 = [];
  busB.subscribe("run-1", (e) => run1.push(e));
  busB.subscribe("run-2", (e) => run2.push(e));
  await tick();
  busA.publish(event("run-2", 1));
  await tick();
  assert.equal(run1.length, 0, "run-1 的订阅者不应收到 run-2 的事件");
  assert.equal(run2.length, 1);
});

test("坏消息（非法 JSON）被静默跳过，不抛错也不投递", async () => {
  const shared = new SharedBus();
  const transportB = createMockTransport(shared);
  const busB = createRedisRunEventBus(transportB);
  const received = [];
  busB.subscribe("run-1", (e) => received.push(e));
  await tick();
  // 直接模拟传输层收到一段无法 JSON.parse 的消息（如 redis 中混杂的脏数据）。
  assert.doesNotThrow(() => transportB._deliver("aiagent:run_events:run-1", "not-json{"));
  await tick();
  assert.equal(received.length, 0);
});
