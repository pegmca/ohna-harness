/**
 * Task 8 · 会话调度、幂等与 run 配置快照测试。
 *
 * 只覆盖调度契约本身：
 * - 同一 conversation 的第二个提交在当前 run 完成前不得调用 start；
 * - 重复 requestId 返回既有 accepted 结果且不再次调用 start；
 * - 取消当前 run 后，排队中的 follow-up 仍会启动。
 *
 * 模型 stream 被替换为可释放的挂起流，避免真实 provider 调用。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaRuntime } from "../dist/index.js";

/** 最小可用模型：与 runtime 现有测试保持同一形状。 */
function makeModel() {
  return {
    id: "scheduler-model",
    name: "Scheduler Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048
  };
}

/** 可控 StreamFn：默认短延迟完成；保持模式下交由测试 releaseLast()。 */
class StreamFnController {
  #calls = [];
  #hold = false;

  streamFn = (model, context, options) => {
    const call = { resolve: undefined, completed: false };
    this.#calls.push(call);
    const stream = createAssistantMessageEventStream();
    const complete = new Promise((resolve) => {
      call.resolve = () => {
        if (call.completed) return;
        call.completed = true;
        resolve();
      };
      if (this.#hold) return;
      setTimeout(call.resolve, 5);
    });
    const signal = options?.signal;
    signal?.addEventListener(
      "abort",
      () => {
        stream.end();
        call.resolve();
      },
      { once: true }
    );
    void complete.then(() => {
      stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [] } });
      stream.end();
    });
    return stream;
  };

  hold() {
    this.#hold = true;
  }

  resume() {
    this.#hold = false;
  }

  reset() {
    this.#calls = [];
    this.#hold = false;
  }

  releaseLast() {
    this.#calls.at(-1)?.resolve();
  }

  started() {
    return this.#calls.length;
  }
}

/**
 * 轮询等待测试条件成立。
 *
 * @param {() => boolean} predicate 条件。
 * @returns {Promise<void>} 条件成立。
 */
async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待测试条件超时。");
}

/** 临时数据目录，测试结束后清理。 */
async function withRuntime(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ohna-scheduler-"));
  const streamController = new StreamFnController();
  const runtime = await createOhnaRuntime({
    dataDir: dir,
    model: makeModel(),
    apiKey: "test-key",
    autoApprove: true,
    streamFn: streamController.streamFn
  });
  try {
    await runtime.registerWorkspace("workspace-test", dir);
    await runtime.startRun({
      conversationId: `conversation-${randomUUID()}`,
      requestId: `request-bootstrap-${randomUUID()}`,
      message: "绑定测试工作区"
    });
    await waitFor(() => streamController.started() === 1);
    streamController.hold();
    streamController.resume();
    streamController.releaseLast();
    await new Promise((resolve) => setTimeout(resolve, 20));
    streamController.reset();
    await fn(runtime, streamController);
  } finally {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("同一 conversation 的 follow-up FIFO 等待当前 run 结束", async () => {
  await withRuntime(async (runtime, streams) => {
    streams.hold();
    const first = await runtime.startRun({
      conversationId: "conversation-fifo",
      workspaceId: "workspace-test",
      requestId: "request-first",
      message: "first"
    });
    let secondStarted = false;
    const second = runtime.startRun({
      conversationId: "conversation-fifo",
      workspaceId: "workspace-test",
      requestId: "request-second",
      message: "second"
    });
    second.then(() => {
      secondStarted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false, "当前 run 未完成前，follow-up 不得启动");
    assert.equal(streams.started(), 1, "同 conversation 不得并发调用第二个 start");

    await runtime.cancelRun(first.accepted.runId);
    streams.resume();
    await second;
    await waitFor(() => streams.started() === 2);
    assert.equal(streams.started(), 2, "首个 run 取消后，follow-up 才开始执行");
  });
});

test("重复 requestId 返回既有 accepted run 且不新建 run", async () => {
  await withRuntime(async (runtime, streams) => {
    const input = {
      conversationId: "conversation-idempotent",
      workspaceId: "workspace-test",
      requestId: "request-duplicate",
      message: "same"
    };
    const first = await runtime.startRun(input);
    const duplicate = await runtime.startRun(input);
    assert.deepEqual(duplicate, first);
    assert.equal(streams.started(), 1, "重复 requestId 不得调用 start 第二次");
    await runtime.cancelRun(first.accepted.runId);
  });
});

test("取消当前 run 不会取消排队中的 follow-up", async () => {
  await withRuntime(async (runtime, streams) => {
    streams.hold();
    const first = await runtime.startRun({
      conversationId: "conversation-cancel",
      workspaceId: "workspace-test",
      requestId: "request-current",
      message: "current"
    });
    const queued = runtime.startRun({
      conversationId: "conversation-cancel",
      workspaceId: "workspace-test",
      requestId: "request-queued",
      message: "queued"
    });
    await runtime.cancelRun(first.accepted.runId);
    streams.resume();
    const followUp = await queued;
    await waitFor(() => streams.started() === 2);
    assert.notEqual(followUp.accepted.runId, first.accepted.runId);
    assert.equal(streams.started(), 2, "排队 follow-up 必须拥有新的 run");
    const snapshot = await runtime.getRunSnapshot(followUp.accepted.runId);
    assert.equal(snapshot.status, "running", "follow-up 不得继承当前 run 的取消");
    await runtime.cancelRun(followUp.accepted.runId);
  });
});

test("并发重复 requestId 只创建一个 run（在途幂等）", async () => {
  await withRuntime(async (runtime, streams) => {
    // 挂起流，使 start 已受理但 run 仍活跃，避免断言前 run 自行终态。
    streams.hold();
    const input = {
      conversationId: "conversation-concurrent-idempotent",
      workspaceId: "workspace-test",
      requestId: "request-concurrent",
      message: "same"
    };
    // 两个提交在 start() 返回前同时到达：都应命中在途 promise，只调用一次 start。
    const [first, second] = await Promise.all([
      runtime.startRun(input),
      runtime.startRun(input)
    ]);
    assert.deepEqual(second, first);
    assert.equal(streams.started(), 1, "并发重复 requestId 不得调用 start 第二次");
    streams.resume();
    await runtime.cancelRun(first.accepted.runId);
  });
});

