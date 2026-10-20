/**
 * W2 serve 观测面测试（docs/v1.4/02-web-llm-trace.md §5 TC-W2-01..06）。
 *
 * 覆盖两条路径：
 * 1. observeRun：CLI 镜像观测（外部执行，serve 只承接事件）；
 * 2. createRun：托管执行，采集层自动把 llm_call 注入同一事件流。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";
import { LocalRunStore } from "../dist/store/run-store.js";

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
  maxTokens: 4_096
};

/** 旧终端（`--web` 托管模式）能渲染的帧类型白名单，见 apps/ohna-cli/src/cli/web-entry.ts。 */
const LEGACY_FRAME_TYPES = new Set([
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_end"
]);

/**
 * 构造 assistant 消息（测试用）。
 *
 * @param {string} text 文本。
 * @param {string} stopReason 停止原因。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: {
      input: 7,
      output: 11,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 构造一条 llm_call 记录（形状对齐 LlmCallRecordDto）。
 *
 * @param {number} callIndex 序号。
 * @returns {object} LlmCallRecordDto。
 */
function llmCallRecord(callIndex = 1) {
  return {
    callId: `call-${callIndex}`,
    callIndex,
    startedAt: Date.now() - 5,
    durationMs: 5,
    attemptCount: 1,
    request: {
      provider: "mock",
      api: "openai-completions",
      modelId: "stub-model",
      baseUrl: "http://127.0.0.1/mock",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      providerPayload: { model: "stub-model", stream: true }
    },
    response: {
      status: 200,
      finishReason: "stop",
      usage: {
        input: 7,
        output: 11,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
        cost: { input: 0, output: 0, read: 0, total: 0 }
      },
      message: assistantMessage("hi")
    }
  };
}

/**
 * 托管路径的 stub StreamFn：在 provider 位置调用 onPayload/onResponse，
 * 模拟真实 adapter 的调用顺序（W1 采集层的端到端验证）。
 *
 * @returns {Function} StreamFn。
 */
function createTracedStream() {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("托管回复");
    queueMicrotask(async () => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      await options?.onPayload?.({ model: model.id, messages: context.messages, stream: true }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {Function} [streamFn] 托管路径的 StreamFn。
 * @param {object} [extra] 额外的 createOhnaServer 选项（如 observeOnly）。
 * @returns {Promise<object>} 测试上下文。
 */
async function createTestServer(streamFn = createTracedStream(), extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-observe-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn,
    ...extra
  });
  return { server, root, dataDir };
}

/**
 * 清理服务与临时目录。
 *
 * @param {object} context 测试上下文。
 */
async function dispose(context) {
  await context.server.shutdown();
  await context.server.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} runId run id。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = (await server.app.inject({ method: "GET", url: `/api/runs/${runId}` })).json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

/**
 * 读取 run 事件文件的所有行。
 *
 * @param {string} dataDir 数据目录。
 * @param {string} runId run id。
 * @returns {Promise<object[]>} 行值。
 */
async function readRunLines(dataDir, runId) {
  const raw = await fs.readFile(path.join(dataDir, "runs", `${runId}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {{id: number, event: object}[]} 帧数组。
 */
function parseSseFrames(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) => {
      const lines = frame.split("\n");
      const id = Number(lines.find((line) => line.startsWith("id:"))?.slice(3).trim());
      const data = lines.find((line) => line.startsWith("data:"));
      return { id, event: JSON.parse(data.slice(5).trim()) };
    });
}

test("TC-W2-01: observeRun 合成序列落盘 llm_call，瞬态 message_update 不落盘", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-1");
    const observed = await server.observeRun({
      conversationId: conversation.conversationId,
      requestId: "session-1:1"
    });

    observed.push({
      type: "message_update",
      message: assistantMessage("partial"),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "p", partial: assistantMessage("p") }
    });
    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.end();

    const snapshot = await waitForTerminal(server, observed.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.mode, "observe");
    assert.equal(snapshot.source, "cli");
    assert.equal(snapshot.requestId, "session-1:1");

    const lines = await readRunLines(dataDir, observed.runId);
    assert.equal(lines[0].type, "run_meta");
    assert.equal(lines[0].mode, "observe");
    const types = lines.slice(1).map((line) => line.type);
    assert.ok(types.includes("llm_call"), "llm_call 应落盘");
    assert.ok(!types.includes("message_update"), "message_update 是瞬态，不应落盘");
    assert.equal(types.at(-1), "run_status");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-02: 观测型 message_end 不写会话消息存储（避免双份）", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-2");
    const observed = await server.observeRun({ conversationId: conversation.conversationId });

    observed.push({ type: "message_end", message: assistantMessage("不应落库") });
    observed.end();
    await waitForTerminal(server, observed.runId);

    const raw = await fs.readFile(
      path.join(dataDir, "conversations", `${conversation.conversationId}.jsonl`),
      "utf8"
    );
    const rows = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.some((row) => row.role === "assistant"),
      false,
      "观测型 run 的 assistant 消息不得写入 conversations store"
    );

    // 但事件本身仍在 run 事件文件里（观测面完整）。
    const types = (await readRunLines(dataDir, observed.runId)).map((line) => line.type);
    assert.ok(types.includes("message_end"));
  } finally {
    await dispose(context);
  }
});

test("TC-W2-03: subscribeRun live 帧与 SSE replay 均按 sequence 有序", async () => {
  const context = await createTestServer();
  try {
    const { server } = context;
    const conversation = await server.createConversation("obs-3");
    const observed = await server.observeRun({ conversationId: conversation.conversationId });

    const live = [];
    const unsubscribe = server.subscribeRun(observed.runId, (event) => live.push(event));

    observed.push({ type: "agent_start" });
    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.push({ type: "agent_end", messages: [] });
    observed.end();
    await waitForTerminal(server, observed.runId);
    unsubscribe();

    assert.deepEqual(
      live.map((event) => event.type),
      ["agent_start", "llm_call", "agent_end", "run_status"]
    );
    assert.deepEqual(
      live.map((event) => event.sequence),
      [...live.map((event) => event.sequence)].sort((left, right) => left - right)
    );

    const sse = await server.app.inject({
      method: "GET",
      url: `/api/runs/${observed.runId}/events?afterSequence=1`
    });
    assert.equal(sse.statusCode, 200);
    const frames = parseSseFrames(sse.body);
    assert.deepEqual(frames.map((frame) => frame.event.type), ["llm_call", "agent_end", "run_status"]);
    assert.deepEqual(frames.map((frame) => frame.id), [2, 3, 4]);
  } finally {
    await dispose(context);
  }
});

test("TC-W2-04: runs 索引按会话列出，状态由内存态覆盖磁盘推导", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-4");
    const observed = await server.observeRun({
      conversationId: conversation.conversationId,
      requestId: "session-4:1"
    });

    const running = (await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    })).json().data;
    assert.equal(running.length, 1);
    assert.equal(running[0].runId, observed.runId);
    assert.equal(running[0].status, "running");
    assert.equal(running[0].mode, "observe");
    assert.equal(running[0].source, "cli");
    assert.equal(running[0].requestId, "session-4:1");
    assert.equal(typeof running[0].createdAt, "string");

    observed.end();
    await waitForTerminal(server, observed.runId);

    const completed = (await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    })).json().data;
    assert.equal(completed[0].status, "completed");

    // 索引文件确实是 append-only JSONL，且不含易变状态字段。
    const indexRaw = await fs.readFile(path.join(dataDir, "runs", "index.jsonl"), "utf8");
    const indexLines = indexRaw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    assert.equal(indexLines.length, 1);
    assert.equal(indexLines[0].type, "run_index");
    assert.equal(indexLines[0].runId, observed.runId);
    assert.equal("status" in indexLines[0], false);

    // 非法 conversationId 直接 400，不触达文件系统。
    const invalid = await server.app.inject({ method: "GET", url: "/api/conversations/bad%20id/runs" });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await dispose(context);
  }
});

test("TC-W2-05: 托管 run 自动发射 llm_call（providerPayload + response 聚合）", async () => {
  const context = await createTestServer();
  try {
    const { server } = context;
    const conversation = await server.createConversation("managed");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "帮我看看",
      requestId: "req-managed-1"
    });
    await waitForTerminal(server, created.accepted.runId);

    const sse = await server.app.inject({ method: "GET", url: created.accepted.eventsUrl });
    const frames = parseSseFrames(sse.body);
    const llmCalls = frames.filter((frame) => frame.event.type === "llm_call");
    assert.equal(llmCalls.length, 1, "一次 LLM 调用产生一条 llm_call");

    const payload = llmCalls[0].event.payload;
    assert.equal(payload.callIndex, 1);
    assert.ok(payload.durationMs > 0);
    assert.equal(payload.attemptCount, 1);
    assert.equal(payload.request.modelId, "stub-model");
    assert.equal(payload.request.baseUrl, "http://127.0.0.1/mock");
    assert.equal(payload.request.providerPayload.stream, true);
    assert.equal(payload.request.providerPayload.messages[0].content, "帮我看看");
    assert.equal(payload.response.status, 200);
    assert.equal(payload.response.finishReason, "stop");
    assert.equal(payload.response.usage.totalTokens, 18);
    assert.equal(payload.response.message.content[0].text, "托管回复");

    // 旧消费方（--web 终端）只认 loop 帧：过滤后不受 llm_call 影响（D7）。
    const legacy = frames.filter((frame) => LEGACY_FRAME_TYPES.has(frame.event.type));
    assert.ok(legacy.length > 0);
    assert.equal(legacy.some((frame) => frame.event.type === "llm_call"), false);
  } finally {
    await dispose(context);
  }
});

test("TC-W2-06: 旧消费方免疫（D7）+ 观测/托管事件在存储层同构", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("parity");

    const observed = await server.observeRun({ conversationId: conversation.conversationId });
    observed.push({ type: "agent_start" });
    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.end();
    await waitForTerminal(server, observed.runId);

    const managed = await server.createRun({
      conversationId: conversation.conversationId,
      message: "ping"
    });
    await waitForTerminal(server, managed.accepted.runId);

    const observedLines = (await readRunLines(dataDir, observed.runId)).slice(1);
    const managedLines = (await readRunLines(dataDir, managed.accepted.runId)).slice(1);
    for (const [label, lines] of [
      ["observe", observedLines],
      ["managed", managedLines]
    ]) {
      const llmCall = lines.find((line) => line.type === "llm_call");
      assert.ok(llmCall, `${label} run 应含 llm_call`);
      // 同一 envelope 字段集（同构存储），仅取值不同。
      assert.deepEqual(
        Object.keys(llmCall).sort(),
        ["conversationId", "createdAt", "eventId", "payload", "requestId", "runId", "sequence", "type"].sort()
      );
      assert.ok(llmCall.payload.request.providerPayload, `${label} run 的 providerPayload 应完整`);

      // 旧终端的白名单过滤：llm_call 被丢弃，其余帧原样保留，过滤逻辑不抛错。
      const legacyFrames = lines.filter((line) => LEGACY_FRAME_TYPES.has(line.type));
      assert.equal(legacyFrames.some((line) => line.type === "llm_call"), false);
      assert.ok(legacyFrames.length > 0, `${label} run 仍有 loop 帧供旧终端渲染`);
    }
  } finally {
    await dispose(context);
  }
});

test("TC-W2-07: cancel 对观测型 run 是 no-op（不空等 5s，之后仍可继续推送）", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-cancel");
    const observed = await server.observeRun({ conversationId: conversation.conversationId });

    const startedAt = Date.now();
    const snapshot = await server.cancelRun(observed.runId);
    const elapsed = Date.now() - startedAt;
    // 执行权在 CLI：serve 取消不 abort 也不等 5s 超时。
    assert.equal(snapshot.status, "running");
    assert.ok(elapsed < 1_000, `cancel 应立即返回（实际 ${elapsed}ms）`);

    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.end();
    await waitForTerminal(server, observed.runId);

    const types = (await readRunLines(dataDir, observed.runId)).map((line) => line.type);
    assert.ok(types.includes("llm_call"), "cancel 之后 push 仍应落盘");
    assert.equal(types.at(-1), "run_status");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-08: end 幂等，end 之后的 push 被丢弃", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-idempotent");
    const observed = await server.observeRun({ conversationId: conversation.conversationId });

    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.end();
    // 第二次 end 与终态后的 push 都必须静默忽略。
    observed.end({ failed: true });
    observed.push({ type: "llm_call", payload: llmCallRecord(2) });
    const snapshot = await waitForTerminal(server, observed.runId);

    assert.equal(snapshot.status, "completed", "首次 end 决定终态");
    const lines = (await readRunLines(dataDir, observed.runId)).slice(1);
    const statuses = lines.filter((line) => line.type === "run_status");
    const calls = lines.filter((line) => line.type === "llm_call");
    assert.equal(statuses.length, 1, "只允许一个 run_status");
    assert.equal(calls.length, 1, "end 之后的 llm_call 必须被丢弃");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-09: end 透传结构化错误到 run_status", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-error");
    const observed = await server.observeRun({ conversationId: conversation.conversationId });
    observed.end({
      failed: true,
      error: { code: "agent_failed", message: "loop 抛出异常", requestId: "req-1" }
    });
    const snapshot = await waitForTerminal(server, observed.runId);

    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.error.code, "agent_failed");
    const statusLine = (await readRunLines(dataDir, observed.runId)).find((line) => line.type === "run_status");
    assert.equal(statusLine.payload.error.message, "loop 抛出异常");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-10: runs 列表按 createdAt 倒序；重复索引行按 runId 去重", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("obs-order");
    const first = await server.observeRun({ conversationId: conversation.conversationId });
    first.end();
    await waitForTerminal(server, first.runId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await server.observeRun({ conversationId: conversation.conversationId });
    second.end();
    await waitForTerminal(server, second.runId);

    const runs = (await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    })).json().data;
    assert.deepEqual(runs.map((run) => run.runId), [second.runId, first.runId]);

    // store 级去重：同 runId 的 create 不会在列表里出现两次。
    const store = new LocalRunStore(path.join(dataDir, "runs"));
    await store.create({
      runId: first.runId,
      requestId: "req-dup",
      conversationId: conversation.conversationId,
      modelId: "stub-model",
      mode: "observe",
      source: "cli",
      userMessageId: "",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const deduped = await store.listRunsByConversation(conversation.conversationId);
    assert.equal(deduped.filter((run) => run.runId === first.runId).length, 1);
    await store.close();
  } finally {
    await dispose(context);
  }
});

test("TC-W2-11: legacy 数据目录（无 runs/index.jsonl）首次查询自动回填索引", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("legacy");
    const runsDir = path.join(dataDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });
    // 模拟 W2 之前的数据：只有 run 文件，没有索引。
    const legacyMeta = {
      type: "run_meta",
      runId: "legacy-run-1",
      requestId: "req-legacy",
      conversationId: conversation.conversationId,
      modelId: "stub-model",
      mode: "auto",
      source: "composer",
      userMessageId: "",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    await fs.writeFile(
      path.join(runsDir, "legacy-run-1.jsonl"),
      `${JSON.stringify(legacyMeta)}\n`,
      "utf8"
    );

    const runs = (await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    })).json().data;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, "legacy-run-1");

    const indexRaw = await fs.readFile(path.join(runsDir, "index.jsonl"), "utf8");
    assert.equal(indexRaw.trim().split("\n").length, 1);
    assert.equal(JSON.parse(indexRaw.trim()).type, "run_index");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-12: 先 create 再 list 时 legacy run 仍被差集回填（51 条）", async () => {
  const context = await createTestServer();
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("legacy-create-first");
    const runsDir = path.join(dataDir, "runs");
    await fs.mkdir(runsDir, { recursive: true });

    // 预置 50 个「只有 run_meta、没有索引」的 legacy run（W2 之前的数据目录）。
    for (let index = 0; index < 50; index += 1) {
      const runId = `legacy-run-${String(index).padStart(2, "0")}`;
      await fs.writeFile(
        path.join(runsDir, `${runId}.jsonl`),
        `${JSON.stringify({
          type: "run_meta",
          runId,
          requestId: `req-${index}`,
          conversationId: conversation.conversationId,
          modelId: "stub-model",
          mode: "auto",
          source: "composer",
          userMessageId: "",
          createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString()
        })}\n`,
        "utf8"
      );
    }

    // 关键顺序：先 create（会写一行索引），再 list。
    const observed = await server.observeRun({ conversationId: conversation.conversationId });
    observed.end();
    await waitForTerminal(server, observed.runId);

    const runs = (await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    })).json().data;
    assert.equal(runs.length, 51, "50 个 legacy + 1 个新建 run 都必须出现");
    assert.equal(runs[0].runId, observed.runId, "新建 run 的 createdAt 最新，排最前");
    assert.ok(runs.some((run) => run.runId === "legacy-run-00"));
    assert.ok(runs.some((run) => run.runId === "legacy-run-49"));

    const indexLines = (await fs.readFile(path.join(runsDir, "index.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.equal(indexLines.length, 51, "索引必须补齐到 51 行且不重复");
  } finally {
    await dispose(context);
  }
});

test("TC-W2-13/S2: observeOnly 不注册写端点，autoApprove 恒 false，GET 与观测仍可用", async () => {
  const context = await createTestServer(createTracedStream(), { observeOnly: true, autoApprove: true });
  try {
    const { server } = context;
    const conversation = await server.createConversation("observe-only");

    // 写端点未注册：浏览器不能借观测台起 run / 取消 run / 放行确认。
    const post = await server.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { conversationId: conversation.conversationId, message: "x" }
    });
    assert.equal(post.statusCode, 404);
    const remove = await server.app.inject({ method: "DELETE", url: "/api/runs/whatever" });
    assert.equal(remove.statusCode, 404);
    const confirm = await server.app.inject({
      method: "POST",
      url: "/api/runs/run-x/confirmations/tool-1",
      payload: { decision: "allow" }
    });
    assert.equal(confirm.statusCode, 404);

    // 即使传了 autoApprove:true，只读模式也强行关闭自动批准。
    assert.equal(server.isAutoApprove(), false);

    // GET 端点保留：非法 run 返回结构化 404 而不是「路由不存在」。
    const snapshot = await server.app.inject({ method: "GET", url: "/api/runs/missing-run" });
    assert.equal(snapshot.statusCode, 404);
    const runs = await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/runs`
    });
    assert.equal(runs.statusCode, 200);

    // 进程内观测入口不受影响（CLI 镜像路径）。
    const observed = await server.observeRun({ conversationId: conversation.conversationId });
    observed.push({ type: "llm_call", payload: llmCallRecord(1) });
    observed.end();
    const terminal = await waitForTerminal(server, observed.runId);
    assert.equal(terminal.status, "completed");
  } finally {
    await dispose(context);
  }
});
