/**
 * W2（docs/v2.0/04 §3）· serve 侧 `context_event` 发射验收。
 *
 * 契约：
 * - 只有 run 前压缩**真的发生**（`compaction.compacted === true`）才发射；未压缩不得发射；
 * - payload 走 `ContextEventPayloadDto`（kind / tokensBefore / tokensAfter / detail）；
 * - 发射点在 `user_message` 之后、`agent_start` 之前，且 sequence 连续可 replay；
 * - `context_event` 属于可落盘事件（不在 TRANSIENT 集合内），断线重连可回放。
 *
 * 触发方式：把模型的 `contextWindow` 调到极小（512）+ 预置超长历史，让 serve 的 run 前
 * 压缩无条件触发；摘要器注入桩（不联网），只验证「压缩发生 + 事件发射」这条链路。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";
import { LocalMessageStore } from "../dist/store/index.js";
import { toContextEventPayload } from "../dist/run/context-event.js";

const SMALL_MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // 极小窗口：让「run 前压缩」必然触发（超窗判定与硬收敛都按 contextWindow 算）。
  contextWindow: 512,
  maxTokens: 256
};

/**
 * 文本流（不联网）。
 *
 * @param {string} text 回复文本。
 * @returns {Function} StreamFn。
 */
function createTextStream(text = "收到。") {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "mock",
      model: SMALL_MODEL.id,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 摘要器桩：返回固定摘要文本（不联网、不依赖凭据）。
 *
 * @param {string} summary 摘要文本。
 * @returns {Function} 摘要器。
 */
function createSummaryStub(summary = "历史摘要：用户要求分析三只股票的估值。") {
  return async () => summary;
}

/**
 * 创建隔离的测试服务。
 *
 * @param {object} [options] 测试选项。
 * @returns {Promise<object>} 测试上下文。
 */
async function createTestServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-ctx-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const messageStore = new LocalMessageStore(path.join(dataDir, "conversations"));
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: SMALL_MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn: createTextStream(),
    ...(options.summarizer ? { summarizer: options.summarizer } : {})
  });
  const conversation = await server.createConversation("上下文事件");
  if (options.seedHistory) {
    // 直接写线性消息存储预置超长历史（HTTP 侧没有「写消息」路由，createRun 才是唯一入口），
    // 每轮都是长文本，保证 token 估算远超 512 的极小窗口。
    const long = "这是一段用于撑爆上下文窗口的历史内容。".repeat(40);
    for (let index = 0; index < 6; index += 1) {
      await messageStore.append(conversation.conversationId, {
        role: index % 2 === 0 ? "user" : "assistant",
        // 线性格式的 assistant.content 是**内容块数组**（message-mapping 原样还原），
        // 写成字符串会让 token 估算器拿不到 content 块而抛错。
        content: index % 2 === 0 ? `${index} ${long}` : [{ type: "text", text: `${index} ${long}` }]
      });
    }
  }
  return { server, root, conversation, messageStore };
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
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组。
 */
function parseSseEvents(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return JSON.parse(data);
    });
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} snapshotUrl 快照地址。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, snapshotUrl) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = (await server.app.inject({ method: "GET", url: snapshotUrl })).json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("[v2.0] run 前压缩触发时发射 context_event：tokens 正确、位于 user_message 之后 agent_start 之前", async () => {
  const context = await createTestServer({ seedHistory: true, summarizer: createSummaryStub() });
  try {
    const { server, conversation } = context;
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "再总结一下"
    });
    const final = await waitForTerminal(server, created.accepted.snapshotUrl);
    assert.equal(final.status, "completed");

    const events = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );
    const contextEvents = events.filter((event) => event.type === "context_event");
    assert.equal(contextEvents.length, 1, "每次 run 至多一条 context_event（run 前压缩一次）");

    const payload = contextEvents[0].payload;
    assert.equal(payload.kind, "compaction");
    assert.equal(typeof payload.tokensBefore, "number");
    assert.equal(typeof payload.tokensAfter, "number");
    // 压缩必须是真的「掉量」：后 < 前，否则不是结构变化。
    assert.ok(payload.tokensAfter < payload.tokensBefore, `压缩后应更小：${payload.tokensAfter} < ${payload.tokensBefore}`);
    // 与超长历史规模对照：压缩前必然远超 512 的小窗口。
    assert.ok(payload.tokensBefore > SMALL_MODEL.contextWindow, "压缩前 token 应超过小窗口");
    assert.match(payload.detail, /摘要/);
    assert.match(payload.detail, /保留 \d+ 条消息/);

    // 顺序：user_message < context_event < agent_start（消费侧先看到「上下文被换过」再看到首轮）。
    const indexOf = (type) => events.findIndex((event) => event.type === type);
    const userIndex = indexOf("user_message");
    const contextIndex = indexOf("context_event");
    const agentIndex = indexOf("agent_start");
    assert.ok(userIndex >= 0 && contextIndex >= 0 && agentIndex >= 0);
    assert.ok(userIndex < contextIndex, "context_event 在 user_message 之后");
    assert.ok(contextIndex < agentIndex, "context_event 在 agent_start 之前");

    // sequence 连续且唯一（事件流已就绪、可 replay）。
    const sequences = events.map((event) => event.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences);
    assert.equal(new Set(sequences).size, sequences.length);

    // 落盘可 replay：重新拉一次同一 URL（replay 通道）仍能拿到该事件。
    const replay = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );
    assert.ok(replay.some((event) => event.type === "context_event"), "context_event 必须可 replay");
  } finally {
    await dispose(context);
  }
});

test("[v2.0] 未触发压缩时不发射 context_event", async () => {
  const context = await createTestServer({ summarizer: createSummaryStub() });
  try {
    const { server, conversation } = context;
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "短问题"
    });
    assert.equal((await waitForTerminal(server, created.accepted.snapshotUrl)).status, "completed");
    const events = parseSseEvents(
      (await server.app.inject({ method: "GET", url: created.accepted.eventsUrl })).body
    );
    assert.equal(
      events.filter((event) => event.type === "context_event").length,
      0,
      "未压缩的 run 不得出现 context_event"
    );
  } finally {
    await dispose(context);
  }
});

test("[v2.0] toContextEventPayload：未压缩返回 undefined，压缩时给出可读 detail", () => {
  assert.equal(
    toContextEventPayload({ compacted: false, tokensBefore: 100, tokensAfter: 100, retainedMessages: 0 }),
    undefined
  );
  const payload = toContextEventPayload({
    compacted: true,
    tokensBefore: 900,
    tokensAfter: 300,
    retainedMessages: 4,
    summary: "摘要正文"
  });
  assert.deepEqual(
    { kind: payload.kind, tokensBefore: payload.tokensBefore, tokensAfter: payload.tokensAfter },
    { kind: "compaction", tokensBefore: 900, tokensAfter: 300 }
  );
  assert.match(payload.detail, /摘要 4 字/);
  assert.match(payload.detail, /保留 4 条消息/);
  assert.match(payload.detail, /净回收 600 token/);
});
