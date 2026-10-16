import assert from "node:assert/strict";
import test from "node:test";
import { createRedisPubSubTransport, createRunEventBusTransportFromEnv } from "../dist/index.js";

test("无 REDIS_URL 时工厂返回空 transport，close 为安全 no-op", async () => {
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    const result = createRunEventBusTransportFromEnv();
    assert.equal(result.transport, undefined, "未配置 REDIS_URL 时不应构造 Redis 连接");
    await assert.doesNotReject(result.close());
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test("配置 REDIS_URL 时工厂返回可关闭的传输层（不主动连接）", async () => {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:6379/0";
  try {
    const result = createRunEventBusTransportFromEnv();
    assert.ok(result.transport, "应构造 Redis 传输层");
    // 仅构建、不 publish/subscribe，因此不会真正发起连接；quit 在未连接时是 no-op。
    await assert.doesNotReject(result.close());
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
    else delete process.env.REDIS_URL;
  }
});

test("createRedisPubSubTransport 可构建且 quit 在未连接时安全", async () => {
  const transport = createRedisPubSubTransport("redis://127.0.0.1:6379/0");
  // 未发起任何命令 → 未连接；quit 不应抛错（即使连不上也不应让关闭流程崩溃）。
  await assert.doesNotReject(transport.quit());
  // 注册消息回调不应抛错（回调在收到消息时才触发）。
  assert.doesNotThrow(() => transport.onMessage(() => {}));
});
