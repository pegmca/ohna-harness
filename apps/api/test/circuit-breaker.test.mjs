import assert from "node:assert/strict";
import test from "node:test";
import { createCircuitBreaker, guardStreamFn } from "../dist/application/circuit-breaker.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 验证熔断器的冷却恢复链路：open →（冷却结束）half-open →（探针成功）closed。
 * 关键回归点：冷却内的快速失败不得重置 openedAt，否则 half-open 探针永不触发、provider 永久跳闸。
 */
test("熔断器 open 后冷却结束能恢复 half-open → closed", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 30 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open");
  // 冷却内多次快速失败（原缺陷会不断刷新 openedAt 到 now）。
  assert.equal(breaker.canAttempt(), false);
  assert.equal(breaker.canAttempt(), false);
  assert.equal(breaker.getState(), "open", "冷却内应仍为 open");
  // 等待冷却结束。
  await sleep(50);
  // 冷却结束应惰性转 half-open 并放行一次探针。
  assert.equal(breaker.canAttempt(), true);
  assert.equal(breaker.getState(), "half-open");
  // 探针成功 → 闭合。
  breaker.recordSuccess();
  assert.equal(breaker.getState(), "closed");
});

test("连续失败达阈值跳闸，且阈值内不跳闸", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.getState(), "closed", "未达阈值不应跳闸");
  breaker.recordFailure();
  assert.equal(breaker.getState(), "open", "达阈值应跳闸 open");
});

test("guardStreamFn 在 OPEN 冷却内快速失败且不重置冷却窗口", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 40 });
  breaker.recordFailure(); // → open
  assert.equal(breaker.getState(), "open");
  const streamFn = guardStreamFn(
    async () => {
      throw new Error("不应在 open 时被调用");
    },
    breaker
  );
  // 冷却内两次请求都应直接快速失败（且不把 openedAt 推后）。
  await assert.rejects(() => streamFn(), /circuit breaker is open/);
  await assert.rejects(() => streamFn(), /circuit breaker is open/);
  assert.equal(breaker.getState(), "open");
  // 冷却结束后应可放行（证明没卡死在 open）。
  await sleep(60);
  assert.equal(breaker.canAttempt(), true, "冷却结束后应允许探针放行");
});

test("guardStreamFn 仅在流以 error 事件收尾时记录失败", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  const okStream = async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "start" };
      yield { type: "done" };
    }
  });
  const failingStream = async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "error", message: "boom" };
    }
  });
  // 必须消费迭代器，失败观测发生在 guardStream 内部。
  const consume = async (streamFn) => {
    const stream = await guardStreamFn(streamFn, breaker)();
    for await (const _event of stream) {
      // 仅消费以触发 guardStream 的失败/成功判定。
    }
  };
  await consume(okStream);
  assert.equal(breaker.getState(), "closed", "正常流不应计数失败");
  await consume(failingStream);
  assert.equal(breaker.getState(), "closed", "一次失败未达阈值");
  await consume(failingStream);
  assert.equal(breaker.getState(), "open", "两次失败应跳闸");
});
