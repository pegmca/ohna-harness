import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeHost, SUBSCRIPTION_BUFFER_LIMIT } from "../dist/main/runtime-host.js";
import {
  routeRuntimeRequest,
  toEventEnvelope,
  isSubscribeMethod,
  UNSUBSCRIBE_METHOD,
} from "../dist/utility/routing.js";
import { PROTOCOL_VERSION } from "@aiagent/types";

/**
 * 内存传输桩：模拟 utilityProcess + MessagePort 的「请求/响应/事件/崩溃」四边形，
 * 内部用 `routeRuntimeRequest` 把信封路由到注入的假 router（fake router，无 Electron）。
 * 这样 `RuntimeHost` 的路由关联、事件扇出、背压与崩溃退避都能在纯 Node 下断言。
 */
class FakeTransport {
  /** @type {((envelope: any) => void) | undefined} */
  responseCb;
  /** @type {((envelope: any) => void) | undefined} */
  eventCb;
  /** @type {((info: { code: number | null, signal: string | null }) => void) | undefined} */
  crashCb;
  started = false;
  /** 已收到的退订 subscriptionId 序列。 */
  unsubscribed = [];
  /** 订阅类方法返回的固定 subscriptionId 自增序列。 */
  nextSubscriptionId = 0;

  constructor(router) {
    this.router = router;
  }

  async start() {
    this.started = true;
  }

  postRequest(envelope) {
    if (envelope.method === UNSUBSCRIBE_METHOD) {
      const id = envelope.payload.subscriptionId;
      this.unsubscribed.push(id);
      this.responseCb?.({
        protocolVersion: PROTOCOL_VERSION,
        requestId: envelope.requestId,
        ok: true,
        data: undefined,
      });
      return;
    }
    if (isSubscribeMethod(envelope.method)) {
      const subscriptionId = `sub-${this.nextSubscriptionId++}`;
      Promise.resolve().then(() => {
        this.responseCb?.({
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          ok: true,
          data: { subscriptionId },
        });
      });
      return;
    }
    routeRuntimeRequest(this.router, envelope).then((response) => {
      this.responseCb?.(response);
    });
  }

  onResponse(cb) {
    this.responseCb = cb;
  }
  onEvent(cb) {
    this.eventCb = cb;
  }
  onCrash(cb) {
    this.crashCb = cb;
  }
  async stop() {
    this.started = false;
  }

  /** 测试辅助：向 host 推送一条事件。 */
  emit(subscriptionId, event) {
    this.eventCb?.(toEventEnvelope(subscriptionId, event));
  }
  /** 测试辅助：触发 worker 崩溃。 */
  crash(info) {
    this.crashCb?.(info);
  }
}

/** 构造一个假的 router，关键方法带可控返回值。 */
function fakeRouter(overrides = {}) {
  return {
    getHealth: async () => ({ status: "ok", protocolVersion: PROTOCOL_VERSION, modelCount: 1, workspaceCount: 0 }),
    getModelCatalog: async () => ({ models: [], protocolVersion: PROTOCOL_VERSION }),
    shutdown: async () => undefined,
    registerWorkspace: async (id) => ({ workspaceId: id, displayPath: "/x", status: "authorized" }),
    listWorkspaces: async () => [],
    releaseWorkspace: async () => undefined,
    startRun: async (input) => ({ accepted: { runId: "r1" }, input }),
    getRunSnapshot: async () => null,
    listRunsByConversation: async () => [],
    cancelRun: async () => null,
    resolveConfirmation: async () => ({ ok: true }),
    createConversation: async (input) => ({ conversationId: "c1", input }),
    listConversations: async () => [],
    updateConversation: async () => null,
    generateConversationTitle: async () => undefined,
    listMessages: async () => null,
    ...overrides,
  };
}

function makeHost(transport, options = {}) {
  return new RuntimeHost({ createTransport: () => transport, ...options });
}

const flush = () => new Promise((r) => setImmediate(r));

test("错误的 protocolVersion 由 host 层强制对齐，正常拿到响应", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  const res = await host.request({ requestId: "p-1", method: "app.getHealth", payload: {} });
  assert.equal(res.protocolVersion, PROTOCOL_VERSION);
  assert.equal(res.ok, true);
});

test("协议版本不匹配由 ipc 层校验（validateEnvelope 返回 protocol_mismatch）", async () => {
  const { validateEnvelope } = await import("../dist/main/envelope.js");
  const err = validateEnvelope({ protocolVersion: 999, requestId: "x", method: "app.getHealth", payload: {} });
  assert.ok(err);
  assert.equal(err.code, "protocol_mismatch");
});

test("未知方法被路由层映射为结构化 bad_request 错误", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  const res = await host.request({ requestId: "u-1", method: "no.such.method", payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "bad_request");
  assert.match(res.error?.message ?? "", /未知方法/);
});

test("缺少必填字段的路由调用返回结构化错误而非抛出", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  const res = await host.request({ requestId: "m-1", method: "conversations.listMessages", payload: { id: 123 } });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "internal_error");
});

test("订阅：注册订阅后 worker 推送的事件会转发给 onEvent", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  const received = [];
  host.subscribe("sub-0", (ev) => received.push(ev));
  transport.emit("sub-0", { kind: "agent_start" });
  await flush();
  await flush();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { kind: "agent_start" });
});

test("退订：unsubscribe 后不再接收事件", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  const received = [];
  const unsub = host.subscribe("sub-1", (ev) => received.push(ev));
  transport.emit("sub-1", { kind: "a" });
  await flush();
  await flush();
  assert.equal(received.length, 1);
  unsub();
  transport.emit("sub-1", { kind: "b" });
  await flush();
  await flush();
  assert.equal(received.length, 1, "退订后不应再收到事件");
});

test("背压：慢消费者下订阅缓冲有上限，不无限增长", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  await host.start();
  host.subscribe("sub-bp", () => {
    const end = Date.now() + 1;
    while (Date.now() < end) {
      /* 慢消费者：同步阻塞制造背压 */
    }
  });
  const total = SUBSCRIPTION_BUFFER_LIMIT * 3;
  for (let i = 0; i < total; i++) {
    transport.emit("sub-bp", { kind: "tick", seq: i });
  }
  assert.ok(
    host.getSubscriptionBufferSize("sub-bp") <= SUBSCRIPTION_BUFFER_LIMIT,
    `缓冲应在 ${SUBSCRIPTION_BUFFER_LIMIT} 以内，实际 ${host.getSubscriptionBufferSize("sub-bp")}`
  );
  assert.ok(host.getSubscriptionDropped("sub-bp") > 0, "慢消费者下应触发背压丢弃");
});

test("runtime 不可用：transport 未就绪时请求返回 runtime_unavailable", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport);
  const res = await host.request({ requestId: "na-1", method: "app.getHealth", payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "runtime_unavailable");
});

test("崩溃退避耗尽后广播 onUnavailable", async () => {
  const transport = new FakeTransport(fakeRouter());
  const host = makeHost(transport, { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 2 });
  const unavailable = [];
  host.onUnavailable(() => unavailable.push("unavailable"));
  await host.start();
  for (let i = 0; i < 40 && unavailable.length === 0; i++) {
    transport.crash({ code: 1, signal: null });
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(unavailable.length, 1, "应广播一次 runtime 不可用");
});

test("正常 request/response：ping 类调用返回结构化数据", async () => {
  const transport = new FakeTransport(
    fakeRouter({
      getHealth: async () => ({ status: "ok", protocolVersion: PROTOCOL_VERSION, modelCount: 3, workspaceCount: 1 }),
    })
  );
  const host = makeHost(transport);
  await host.start();
  const res = await host.request({ requestId: "h-1", method: "app.getHealth", payload: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { status: "ok", protocolVersion: PROTOCOL_VERSION, modelCount: 3, workspaceCount: 1 });
});

test("preload 纯函数 validateRequest 拒绝畸形 runs.start 入参", async () => {
  const { validateRequest } = await import("../dist/preload/contract.js");
  assert.equal(validateRequest("runs.start", { input: { conversationId: "", message: "hi" } })?.code, "bad_request");
  assert.equal(validateRequest("runs.start", { input: { conversationId: "c1", message: "" } })?.code, "bad_request");
  assert.equal(validateRequest("runs.start", { input: { conversationId: "c1", message: "hi" } }), null);
  assert.equal(validateRequest("events.subscribeRun", { id: "" })?.code, "bad_request");
  assert.equal(validateRequest("events.subscribeRun", { id: "r1" }), null);
});

test("preload SDK 暴露面只包含语义方法，无 ipcRenderer/invoke/Node", async () => {
  const { createOhnaSdk } = await import("../dist/preload/sdk.js");
  const sent = [];
  const sdk = createOhnaSdk(async (_ch, env) => {
    sent.push(env);
    return { ok: true, data: { subscriptionId: "s1" } };
  });
  const keys = Object.keys(sdk).sort();
  assert.deepEqual(keys, ["app", "conversations", "events", "models", "runs", "workspaces"]);
  for (const ns of Object.values(sdk)) {
    for (const fn of Object.values(ns)) {
      assert.equal(typeof fn, "function");
    }
  }
  assert.equal(sdk.ipcRenderer, undefined);
  assert.equal(sdk.invoke, undefined);
  assert.equal(sdk.require, undefined);
  assert.equal(sdk.process, undefined);
});

test("preload SDK 校验失败时不会触达 invoke（不把畸形 payload 送上 IPC）", async () => {
  const { createOhnaSdk } = await import("../dist/preload/sdk.js");
  const sent = [];
  const sdk = createOhnaSdk(async (_ch, env) => {
    sent.push(env);
    return { ok: true, data: {} };
  });
  await assert.rejects(() => sdk.runs.start({ conversationId: "", message: "hi" }), /conversationId/);
  assert.equal(sent.length, 0, "校验失败不应发送任何 IPC 请求");
});
