/**
 * W3 观测接线测试（docs/v1.4/02-web-llm-trace.md §5 TC-W3-02..04）。
 *
 * 只覆盖「接线」本身：runTurn 是否按序把事件与 llm_call 镜像给句柄、--no-web 的
 * 文件 sink 是否逐行落盘、host 装配失败是否降级而不阻塞。真实的 CLI 交互由
 * test/verify-ohna-m3.mjs 与手工验收覆盖。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createUsageTracker } from "../dist/ui/render.js";
import { runTurn } from "../dist/runtime/turn.js";
import { createLlmTraceFileSink } from "../dist/runtime/llm-trace-file.js";
import {
  createObservationRef,
  createServerTurnObserver,
} from "../dist/runtime/observation.js";
import { hostOhnaWeb, releaseHost } from "../dist/cli/web-host.js";

const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const ACTIVE = { model: MODEL, apiKey: "test-key" };

/**
 * 构造 assistant 消息（测试用）。
 *
 * @param {string} text 文本。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * 假 streamFn：模拟真实 adapter 的 onPayload/onResponse 调用顺序。
 *
 * @returns {Function} StreamFn。
 */
function createStubStream() {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("stub reply");
    queueMicrotask(async () => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      await options?.onPayload?.({ model: model.id, stream: true, messages: context.messages }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      stream.push({ type: "text_delta", contentIndex: 0, delta: "stub reply", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 创建临时目录。
 *
 * @returns {Promise<string>} 目录路径。
 */
async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ohna-cli-observe-"));
}

test("TC-W3-02: runTurn 把 loop 事件与 llm_call 按序推给观测句柄并收尾", async () => {
  const dir = await tempDir();
  const received = [];
  let ended;
  const observation = {
    push: (event) => received.push(event),
    end: (result) => {
      ended = result;
    },
  };

  try {
    const result = await runTurn(
      [],
      "帮我看看",
      ACTIVE,
      [],
      new AbortController().signal,
      {
        systemPrompt: "sys",
        autoApprove: true,
        cwd: dir,
        summarizer: async () => "summary",
        streamFn: createStubStream(),
      },
      createUsageTracker(),
      undefined,
      undefined,
      undefined,
      observation,
    );

    assert.equal(result.failed, false);
    const types = received.map((event) => event.type);
    assert.ok(types.includes("agent_start"), "应收到 agent_start");
    assert.ok(types.includes("message_start"), "应收到 message_start");
    assert.ok(types.includes("message_end"), "应收到 message_end");
    assert.ok(types.includes("agent_end"), "应收到 agent_end");

    const llmCallIndex = types.indexOf("llm_call");
    assert.ok(llmCallIndex >= 0, "应收到 llm_call");
    // 前一个 message_end 是用户 prompt；助手那条必须晚于 llm_call（采集记录先于终态透传）。
    const assistantMessageEnd = types.lastIndexOf("message_end");
    assert.ok(llmCallIndex < assistantMessageEnd, "llm_call 先于助手的 message_end");
    assert.ok(types.indexOf("message_start", llmCallIndex) > llmCallIndex, "助手消息在 llm_call 之后开始");
    const record = received[llmCallIndex].payload;
    assert.equal(record.callIndex, 1);
    assert.equal(record.request.providerPayload.stream, true);
    assert.equal(record.response.status, 200);
    assert.equal(record.response.usage.totalTokens, 8);

    assert.deepEqual(ended, { failed: false });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TC-W3-03: --no-web 文件 sink 每行一条记录，目录自动创建且失败静默", async () => {
  const dir = await tempDir();
  const traces = path.join(dir, "traces");
  try {
    const sink = createLlmTraceFileSink("session-1", traces);
    const record = { callId: "c1", callIndex: 1, attemptCount: 1, request: { modelId: "stub-model" } };
    sink(record);
    // append 是异步 fire-and-forget：轮询等待文件出现。
    let raw = "";
    for (let attempt = 0; attempt < 100 && raw === ""; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      raw = await fs.readFile(path.join(traces, "session-1.jsonl"), "utf8").catch(() => "");
    }
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), record);

    // 不可写目录（用文件占位）不抛错：观测失败静默降级。
    const blocker = path.join(dir, "blocked");
    await fs.writeFile(blocker, "x", "utf8");
    assert.doesNotThrow(() => createLlmTraceFileSink("session-2", path.join(blocker, "nested"))(record));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TC-W3-04: 观测台装配失败 resolve undefined；同进程只允许一个 host", async () => {
  const dir = await tempDir();
  try {
    const workspaceRoot = path.join(dir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });

    const hosted = await hostOhnaWeb({
      workspaceRoot,
      active: ACTIVE,
      tools: [],
      autoApprove: true,
      port: 0,
      conversationTitle: "CLI · test",
      dataDir: path.join(dir, "data"),
    });
    assert.ok(hosted, "首次装配应成功");
    assert.match(hosted.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    // 单进程第二个 host 直接拒绝（单入口分发之外的显式断言）。
    const second = await hostOhnaWeb({
      workspaceRoot,
      active: ACTIVE,
      tools: [],
      autoApprove: true,
      port: 0,
      conversationTitle: "dup",
      dataDir: path.join(dir, "data"),
    });
    assert.equal(second, undefined);

    await hosted.server.shutdown();
    await hosted.server.close();
    releaseHost();

    // 非法端口 → 装配失败 → undefined（调用方降级为纯本地，不抛错）。
    const failed = await hostOhnaWeb({
      workspaceRoot,
      active: ACTIVE,
      tools: [],
      autoApprove: true,
      port: -1,
      conversationTitle: "bad",
      dataDir: path.join(dir, "data"),
    });
    assert.equal(failed, undefined);
  } finally {
    releaseHost();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TC-W3-05: createServerTurnObserver 缓冲 warm-up 期间的事件并按序 flush", async () => {
  const pushed = [];
  let ended;
  const fakeHandle = {
    push: (event) => pushed.push(event),
    end: (result) => {
      ended = result;
    },
  };
  let resolveObserve;
  const server = {
    observeRun: () =>
      new Promise((resolve) => {
        resolveObserve = resolve;
      }),
  };
  const ref = createObservationRef();
  const observer = createServerTurnObserver({ server, conversationId: "conv-1", ref, counter: { value: 0 } });
  const handle = observer.start("hi", { sessionId: "sess-1", runIndex: 1 });

  assert.equal(ref.current, handle, "start 后应绑定当前观测句柄");
  handle.push({ type: "message_start", message: { role: "user" } });
  handle.push({ type: "llm_call", payload: { callId: "c1" } });
  handle.end({ failed: true });

  resolveObserve(fakeHandle);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(pushed.map((event) => event.type), ["message_start", "llm_call"]);
  assert.deepEqual(ended, { failed: true });
  assert.equal(ref.current, undefined, "end 后应释放当前句柄");
});

test("N6: observeRun reject（非法 conversationId 等）不得带崩 CLI，句柄降级为空操作", async () => {
  const ref = createObservationRef();
  const server = {
    observeRun: () => Promise.reject(new Error("conversationId 格式不正确"))
  };
  const observer = createServerTurnObserver({ server, conversationId: "bad id", ref, counter: { value: 0 } });
  const handle = observer.start("hi", { sessionId: "sess-1", runIndex: 1 });

  assert.doesNotThrow(() => handle.push({ type: "agent_start" }));
  assert.doesNotThrow(() => handle.end({ failed: false }));
  // 失败后引用必须解绑，后续 run 不会误推到坏句柄上。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ref.current, undefined);
});

test("N6b: observeRun 同步抛错同样被吞掉（观测降级）", () => {
  const ref = createObservationRef();
  const server = {
    observeRun: () => {
      throw new Error("sync failure");
    }
  };
  const observer = createServerTurnObserver({ server, conversationId: "conv-1", ref, counter: { value: 0 } });
  assert.doesNotThrow(() => observer.start("hi", { sessionId: "sess-1", runIndex: 1 }));
  assert.equal(ref.current, undefined);
});

test("S1: 主线程 2 次 + 子代理 1 次共用 counter，callIndex 严格 1,2,3", async () => {
  const { createTracedStreamFn } = await import("../dist/runtime/observation.js");
  const records = [];
  const handle = {
    push: (event) => {
      if (event.type === "llm_call") records.push(event.payload);
    },
    end: () => undefined,
  };
  const ref = createObservationRef();
  const counter = { value: 0 };
  const base = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("ok");
    queueMicrotask(async () => {
      await options?.onPayload?.({ model: model.id }, model);
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  const streamFn = createTracedStreamFn(() => ref.current, counter, base);
  ref.current = handle;

  const drain = async () => {
    for await (const _event of streamFn(MODEL, { messages: [] }, {})) {
      // 消费完整事件流，触发采集记录。
    }
  };

  await drain(); // 主线程第 1 次
  await drain(); // 主线程第 2 次
  await drain(); // 子代理（同一个 streamFn 实例 / 同一个 counter）

  assert.deepEqual(records.map((record) => record.callIndex), [1, 2, 3]);

  // 新一轮 run 由 observer.start 归零后从 1 重新开始。
  counter.value = 0;
  await drain();
  assert.equal(records.at(-1).callIndex, 1);
});

test("N1: flushTraceWrites 等待所有排队写入落盘", async () => {
  const { flushTraceWrites } = await import("../dist/runtime/llm-trace-file.js");
  const dir = await tempDir();
  try {
    const sink = createLlmTraceFileSink("sess-flush", dir);
    sink({ callId: "c1", callIndex: 1 });
    sink({ callId: "c2", callIndex: 2 });
    sink({ callId: "c3", callIndex: 3 });
    await flushTraceWrites();

    const raw = await fs.readFile(path.join(dir, "sess-flush.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).callId, "c3");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("防御: 观测器漏传 counter 时 start() 不抛 TypeError", async () => {
  const { createFileTurnObserver } = await import("../dist/runtime/observation.js");
  const dir = await tempDir();
  try {
    const ref = createObservationRef();
    // 故意不传 counter（模拟 JS 调用方 / 未来字段改可选）。
    const fileObserver = createFileTurnObserver({ ref, baseDir: dir });
    assert.doesNotThrow(() => {
      const handle = fileObserver.start("hi", { sessionId: "sess-x", runIndex: 1 });
      handle.end();
    });

    const serverObserver = createServerTurnObserver({
      server: { observeRun: () => Promise.reject(new Error("boom")) },
      conversationId: "conv-1",
      ref
    });
    assert.doesNotThrow(() => serverObserver.start("hi", { sessionId: "sess-x", runIndex: 1 }).end());
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("S1(回归): 构造期同步抛错时 observation.end 仍被调用，且标记 failed", async () => {
  // ① setup 缺失 → createConfig 同步抛 TypeError（旧实现里 createConfig 在 try 外，end 不会被调用）。
  let ended;
  await assert.rejects(
    runTurn(
      [],
      "hi",
      ACTIVE,
      [],
      new AbortController().signal,
      undefined,
      createUsageTracker(),
      undefined,
      undefined,
      undefined,
      { push: () => undefined, end: (result) => { ended = result; } },
    ),
    TypeError,
  );
  assert.deepEqual(ended, { failed: true });

  // ② streamFn 构造期抛错 → loop 内部兜底成 agent_end.error，runTurn 返回 failed 且镜像 run 收尾为 failed。
  ended = undefined;
  const boom = new Error("stream construct failed");
  const result = await runTurn(
    [],
    "hi",
    ACTIVE,
    [],
    new AbortController().signal,
    {
      systemPrompt: "sys",
      autoApprove: true,
      cwd: process.cwd(),
      summarizer: async () => "summary",
      streamFn: () => {
        throw boom;
      },
    },
    createUsageTracker(),
    undefined,
    undefined,
    undefined,
    { push: () => undefined, end: (value) => { ended = value; } },
  );
  assert.equal(result.failed, true);
  assert.deepEqual(ended, { failed: true });
});
