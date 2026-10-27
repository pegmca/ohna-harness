/**
 * Task 9 · 原子 run 创建与 replay/live 订阅测试。
 *
 * 使用注入 streamFn 的事件序列驱动真实 RunManager / store / runtime 装配，
 * 覆盖 startRun 原子返回、live 序列不重复、afterSequence 回放与退订。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaRuntime } from "../dist/index.js";

/** 最小可用模型：与 runtime 既有测试保持同一形状。 */
function makeModel() {
  return {
    id: "replay-model",
    name: "Replay Model",
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

/** 流完成后等待 run 状态落定，避免轮询实现细节暴露到断言。 */
async function waitFor(predicate, message = "等待测试条件超时。") {
  for (let i = 0; i < 300; i += 1) {
    // predicate 可能返回 Promise<boolean>（如 waitTerminal 里读快照），
    // 必须 await 其结果——否则 Promise 永远为真，循环会立即退出而不真正等待。
    const satisfied = await predicate();
    if (satisfied) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/** 等待 run 到达明确终态（completed/failed/interrupted）。 */
async function waitTerminal(runtime, runId) {
  await waitFor(
    () =>
      runtime.getRunSnapshot(runId).then((snapshot) =>
        snapshot?.status === "completed" || snapshot?.status === "failed" || snapshot?.status === "interrupted"
      ),
    "等待 run 到达明确终态"
  );
}

/** 注入 streamFn：产生一个 message_update 瞬态帧 + message_end，并立即完成。 */
function stubStreamFn() {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "收到。" }],
      stopReason: "stop"
    };
    const partial = { ...message, content: [] };
    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "收", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "到。", partial });
      stream.push({ type: "text_end", contentIndex: 0, content: "收到。", partial });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
}

/**
 * 创建临时 runtime。
 *
 * @returns {Promise<{runtime: object, dir: string}>} runtime 与临时目录。
 */
async function withRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "ohna-replay-"));
  const runtime = await createOhnaRuntime({
    dataDir: dir,
    model: makeModel(),
    apiKey: "test-key",
    autoApprove: true,
    streamFn: stubStreamFn()
  });
  await runtime.registerWorkspace("workspace-replay", dir);
  return { runtime, dir };
}

test("startRun 原子返回初始事件，live 事件严格递增且不重复", async () => {
  const { runtime, dir } = await withRuntime();
  const conversationId = `conversation-${randomUUID()}`;
  try {
    const result = await runtime.startRun({
      conversationId,
      workspaceId: "workspace-replay",
      requestId: `request-${randomUUID()}`,
      message: "hello"
    });
    assert.ok(result.subscriptionId, "startRun 必须返回真实订阅 id");
    assert.ok(
      result.initialEvents.some((event) => event.type === "user_message"),
      "initialEvents 必须包含 user_message"
    );
    assert.ok(
      result.initialEvents.every((event) => event.sequence > 0),
      "initialEvents 必须携带 sequence"
    );

    // 订阅必须在 run 结束前建立，才能观察到 live 帧（含可能的瞬态 message_update）。
    // afterSequence:0 回放已落盘事件（user_message 等），之后继续投递 live 帧；
    // message_update 是瞬态事件，永不落盘，故只可能出现在 live 帧、不得要求出现在回放。
    const liveEvents = [];
    const subscription = await runtime.subscribeRun(result.accepted.runId, {
      afterSequence: 0,
      onEvent: (event) => liveEvents.push(event)
    });
    assert.ok(subscription.subscriptionId);
    await waitFor(() => liveEvents.some((event) => event.type === "run_status"), "等待 live 流到达终态");

    // live 帧自身必须 sequence 不重复、不倒退；终态以 run_status 结束（agent_end 不关闭流）。
    const sequences = liveEvents.map((event) => event.sequence);
    assert.deepEqual([...new Set(sequences)].length, sequences.length, "live 事件 sequence 不得重复");
    assert.deepEqual([...sequences].sort((left, right) => left - right), sequences, "live 事件 sequence 不得倒退");
    assert.ok(liveEvents.some((event) => event.type === "run_status"), "live 流必须到达终态");
    subscription.unsubscribe();
  } finally {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscribeRun afterSequence 只回放已落盘且大于阈值的事件", async () => {
  const { runtime, dir } = await withRuntime();
  const conversationId = `conversation-${randomUUID()}`;
  try {
    const result = await runtime.startRun({
      conversationId,
      workspaceId: "workspace-replay",
      requestId: `request-${randomUUID()}`,
      message: "hello"
    });
    // 必须等到明确的终态值，不能只判断「非 running」：snapshot 为 undefined 时
    // `undefined !== "running"` 也为 true，会提前退出导致在 run 仍在 live 阶段就订阅、误收瞬态 message_update。
    await waitTerminal(runtime, result.accepted.runId);

    const events = [];
    const subscription = await runtime.subscribeRun(result.accepted.runId, {
      afterSequence: 1,
      onEvent: (event) => events.push(event)
    });
    // replay 读盘是异步的，需等待事件真正投递（setImmediate 过短会导致断言提前）。
    await waitFor(() => events.length > 0, "等待终态 run 的 replay 事件投递");
    assert.ok(events.every((event) => event.sequence > 1), "afterSequence 必须严格过滤");
    assert.ok(!events.some((event) => event.type === "message_update"), "回放不得包含瞬态事件");
    assert.ok(events.some((event) => event.type === "run_status"), "回放必须包含终态 run_status");
    subscription.unsubscribe();
  } finally {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsubscribe 后不再收到事件", async () => {
  const { runtime, dir } = await withRuntime();
  const conversationId = `conversation-${randomUUID()}`;
  try {
    const before = await runtime.startRun({
      conversationId,
      workspaceId: "workspace-replay",
      requestId: `request-before-${randomUUID()}`,
      message: "before"
    });
    await waitTerminal(runtime, before.accepted.runId);

    const events = [];
    const subscription = await runtime.subscribeRun(before.accepted.runId, {
      onEvent: (event) => events.push(event)
    });
    subscription.unsubscribe();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [], "退订后不得继续投递事件");

    const after = await runtime.startRun({
      conversationId,
      workspaceId: "workspace-replay",
      requestId: `request-after-${randomUUID()}`,
      message: "after"
    });
    await waitTerminal(runtime, after.accepted.runId);
    assert.deepEqual(events, [], "退订后的新 run 也不得向旧 listener 投递");
  } finally {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
