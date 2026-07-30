import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageEventStream,
  combineAbortSignals,
  parseStreamingJson,
  partialParse,
  repairJson,
  retryProviderRequest
} from "../dist/index.js";

test("parseStreamingJson：完整 JSON 直接解析", () => {
  assert.deepEqual(parseStreamingJson('{"a":1,"b":[true,null]}'), { a: 1, b: [true, null] });
  assert.deepEqual(parseStreamingJson(""), {});
  assert.deepEqual(parseStreamingJson(undefined), {});
});

test("parseStreamingJson：截断 JSON 走 partialParse 容错", () => {
  // 未闭合字符串丢弃所在的对。
  assert.deepEqual(parseStreamingJson('{"a":1,"b":"x'), { a: 1 });
  // 值未开始即截断 → 该对整体丢弃。
  assert.deepEqual(parseStreamingJson('{"a":'), {});
  // 容器未闭合返回已解析部分。
  assert.deepEqual(parseStreamingJson('{"a":1'), { a: 1 });
  assert.deepEqual(parseStreamingJson("[1,2"), [1, 2]);
  // 彻底无法解析返回 {}，永不抛错。
  assert.deepEqual(parseStreamingJson("###"), {});
});

test("parseStreamingJson：字符串内裸控制字符经 repairJson 修复", () => {
  assert.deepEqual(parseStreamingJson('{"a":"line1\nline2"}'), { a: "line1\nline2" });
});

test("partialParse：字面量前缀截断返回 undefined", () => {
  assert.equal(partialParse("tr"), undefined);
  assert.equal(partialParse('"abc'), undefined);
  assert.deepEqual(partialParse('{"k":"v"}'), { k: "v" });
});

test("repairJson：非法转义前的反斜杠加倍", () => {
  assert.equal(repairJson('{"a":"x\\y"}'), '{"a":"x\\\\y"}');
});

test("AssistantMessageEventStream：result() 在 done 时 resolve，迭代收齐全事件", async () => {
  const eventStream = new AssistantMessageEventStream();
  const message = { role: "assistant", content: [], stopReason: "stop" };
  eventStream.push({ type: "start", partial: message });
  eventStream.push({ type: "done", reason: "stop", message });
  eventStream.end();

  const events = [];
  for await (const event of eventStream) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["start", "done"]);
  assert.equal(await eventStream.result(), message);
});

/** 构造带 status/headers 的 provider 错误形状。 */
function providerError(status, headers) {
  const error = new Error(`${status}: boom`);
  error.status = status;
  error.headers = new Headers(headers);
  return error;
}

test("retryProviderRequest：429 按 retry-after-ms 重试一次后成功", async () => {
  let calls = 0;
  const result = await retryProviderRequest(async () => {
    calls += 1;
    if (calls === 1) throw providerError(429, { "retry-after-ms": "1" });
    return "ok";
  }, { maxRetries: 2 });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("retryProviderRequest：400 不可重试立即抛出；x-should-retry:false 覆盖 429", async () => {
  let calls = 0;
  await assert.rejects(
    retryProviderRequest(async () => {
      calls += 1;
      throw providerError(400, {});
    }, { maxRetries: 3 }),
    /400/
  );
  assert.equal(calls, 1);

  await assert.rejects(
    retryProviderRequest(async () => {
      throw providerError(429, { "x-should-retry": "false" });
    }, { maxRetries: 3 }),
    /429/
  );
});

test("retryProviderRequest：AbortSignal 打断退避 sleep", async () => {
  const controller = new AbortController();
  const promise = retryProviderRequest(async () => {
    throw providerError(429, { "retry-after-ms": "5000" });
  }, { maxRetries: 3, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (error) => error.name === "AbortError");
});

test("retryProviderRequest：服务端要求超过 maxRetryDelayMs 立即失败", async () => {
  let calls = 0;
  await assert.rejects(
    retryProviderRequest(async () => {
      calls += 1;
      throw providerError(429, { "retry-after-ms": "120000" });
    }, { maxRetries: 3, maxRetryDelayMs: 1000 }),
    /retry delay/
  );
  assert.equal(calls, 1);
});

test("combineAbortSignals：任一信号中断即中断，reason 透传", () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineAbortSignals([a.signal, b.signal, undefined]);
  assert.equal(combined.signal.aborted, false);
  b.abort("bye");
  assert.equal(combined.signal.aborted, true);
  assert.equal(combined.signal.reason, "bye");
  combined.cleanup();

  assert.equal(combineAbortSignals([undefined]).signal, undefined);
  assert.equal(combineAbortSignals([a.signal]).signal, a.signal);
});

test("repairJson：非法 \\u 转义（截断的 \\u12）按非法转义双写反斜杠", () => {
  // 修复前 \u12" 会被原样拷贝导致 JSON.parse 失败；修复后 \\u12 成为合法字面量。
  const repaired = repairJson('{"a":"x\\u12"}');
  assert.equal(repaired, '{"a":"x\\\\u12"}');
  assert.deepEqual(JSON.parse(repaired), { a: "x\\u12" });
  // 合法 \u 转义不受影响。
  assert.equal(repairJson('{"a":"\\u4f60"}'), '{"a":"\\u4f60"}');
  assert.deepEqual(parseStreamingJson('{"a":"x\\u12"}'), { a: "x\\u12" });
});

test("retryProviderRequest：无 retry-after 头时指数退避（0.5s 封顶 8s，负抖动）", async () => {
  // 固定 Math.random = 0 消除抖动：第一次重试等待恰为 0.5 * 2^0 = 500ms。
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    let calls = 0;
    const started = Date.now();
    const result = await retryProviderRequest(async () => {
      calls += 1;
      if (calls === 1) throw providerError(429, {});
      return "ok";
    }, { maxRetries: 1 });
    const elapsed = Date.now() - started;
    assert.equal(result, "ok");
    assert.equal(calls, 2);
    // 允许计时器误差的下界，远大于 0 说明确实走了退避而非立即重试。
    assert.ok(elapsed >= 450, `expected backoff >= 450ms, got ${elapsed}ms`);
    assert.ok(elapsed < 2000, `expected backoff < 2000ms, got ${elapsed}ms`);
  } finally {
    Math.random = originalRandom;
  }
});
