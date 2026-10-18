import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "@aiagent/ai";
import { createApiServer } from "../dist/index.js";
import { createInMemoryApiTestRuntime } from "../dist/adapters/in-memory-test-runtime.js";
import { createInMemoryConversationStores } from "../dist/adapters/in-memory-conversation-store.js";
import { createInMemoryRunStore } from "../dist/adapters/in-memory-run-runtime.js";
import { createModelRuntimeRegistry } from "../dist/application/model-registry.js";

/**
 * 阶段 0「真实化运行时」的核心证据：run-service 把真实 provider 的 token 增量
 * （streamSimple 产出的 text_delta）原样落 run_events 并经 SSE 广播，而 loop 控制流未改。
 * 这里用 mock fetch 模拟一个 OpenAI 兼容端点返回两个文本增量，验证：
 * 1) 真实 streamSimple 链路被 agentLoop / run-service 复用（StreamFn 边界不变）；
 * 2) run_events 中出现 message_update 且 payload.assistantMessageEvent.type === "text_delta"。
 */

/** 把 chat completions chunk 列表编码为 SSE Response。 */
function sseResponse(chunks) {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(lines), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** 返回固定两段文本增量的 mock fetch（模拟真实 provider 的流式响应）。 */
function mockStreamingFetch() {
  return async () =>
    sseResponse([
      { id: "cmpl-1", model: "deepseek-chat", choices: [{ delta: { content: "你" }, finish_reason: null }] },
      { id: "cmpl-1", model: "deepseek-chat", choices: [{ delta: { content: "好" }, finish_reason: null }] },
      { id: "cmpl-1", model: "deepseek-chat", choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
}

/** 构建一个走真实 streamSimple（mock fetch）的 DeepSeek 运行时。 */
function streamingDeepSeekRuntime() {
  const model = {
    id: "deepseek-chat",
    name: "deepseek-chat",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  };
  const streamFn = (modelArg, context) => streamSimple(modelArg, context, { apiKey: "test-key", fetch: mockStreamingFetch() });
  return { model, streamFn };
}

async function bootstrap(app, visitorId) {
  const response = await app.inject({
    method: "POST", url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return { cookie: response.headers["set-cookie"].split(";")[0], userId: response.json().data.userId };
}

async function createConversation(app, cookie, title = "真实流式会话") {
  const response = await app.inject({
    method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title }
  });
  assert.equal(response.statusCode, 201);
  return response.json().data.conversationId;
}

async function waitForTerminal(app, snapshotUrl, headers = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl, headers });
    const snapshot = response.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach terminal state.");
}

test("real streamSimple 经 run-service 产生 message_update/text_delta 事件（StreamFn 边界不变）", async () => {
  const conversationStores = createInMemoryConversationStores();
  const runStore = createInMemoryRunStore({ messageStore: conversationStores.messageStore });
  const runtime = createInMemoryApiTestRuntime({
    stores: {
      runStore,
      conversationRepository: conversationStores.conversationRepository,
      messageStore: conversationStores.messageStore
    }
  });
  const { model, streamFn } = streamingDeepSeekRuntime();
  const modelRegistry = createModelRuntimeRegistry([{
    option: {
      id: "deepseek", label: "DeepSeek", provider: "deepseek",
      description: "测试用", isDefault: true,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: { model, apiKey: "test-key", streamFn }
  }], "deepseek");

  const app = createApiServer({ ...runtime, modelRegistry });
  const { cookie, userId } = await bootstrap(app, "real-stream-visitor");
  const conversationId = await createConversation(app, cookie);

  const createResponse = await app.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: {
      message: "你好", conversationId, modelId: "deepseek",
      mode: "auto", source: "composer", clientMessageId: "real-stream-c1"
    }
  });
  assert.equal(createResponse.statusCode, 202);
  const { runId, snapshotUrl } = createResponse.json().data;

  const terminal = await waitForTerminal(app, snapshotUrl, { cookie });
  assert.equal(terminal.status, "completed");

  const events = await runStore.listEvents(userId, runId, 0);
  assert.ok(events && events.length > 0, "run_events 至少应有一条事件");

  // 终端态之前必须出现 message_update，且其中携带 text_delta 增量。
  const messageUpdates = events.filter((event) => event.type === "message_update");
  assert.ok(messageUpdates.length > 0, "应出现 message_update 事件用于逐 token 流式渲染");
  const textDeltas = messageUpdates.filter(
    (event) => event.payload?.assistantMessageEvent?.type === "text_delta"
  );
  assert.ok(textDeltas.length >= 2, "应至少出现两段文本增量（你 / 好）");
  // 累积 partial 应逐步拼出最终文本。
  assert.equal(textDeltas.at(-1).payload.assistantMessageEvent.partial.content[0].text, "你好");

  // 最终 assistant 消息落库为完整文本，证明 loop 控制流未因换成真实 streamFn 而改变。
  const agentEnd = events.find((event) => event.type === "agent_end");
  assert.ok(agentEnd, "应出现 agent_end 终态事件");
  const finalAssistant = (agentEnd.payload.messages ?? [])
    .filter((message) => message.role === "assistant")
    .at(-1);
  assert.equal(finalAssistant.content[0].text, "你好");

  await app.close();
});

test("real 模式目录只暴露已配置的 profile，不会出现 has()=false 的幽灵模型", async () => {
  const conversationStores = createInMemoryConversationStores();
  const runStore = createInMemoryRunStore({ messageStore: conversationStores.messageStore });
  const runtime = createInMemoryApiTestRuntime({
    stores: {
      runStore,
      conversationRepository: conversationStores.conversationRepository,
      messageStore: conversationStores.messageStore
    }
  });
  const { model, streamFn } = streamingDeepSeekRuntime();
  const modelRegistry = createModelRuntimeRegistry([{
    option: {
      id: "deepseek", label: "DeepSeek", provider: "deepseek",
      description: "测试用", isDefault: true,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: { model, apiKey: "test-key", streamFn }
  }], "deepseek");

  const app = createApiServer({ ...runtime, modelRegistry });
  const response = await app.inject({ method: "GET", url: "/api/models" });
  assert.equal(response.statusCode, 200);
  const catalog = response.json().data;
  assert.deepEqual(catalog.models.map((m) => m.id), ["deepseek"]);
  assert.equal(catalog.defaultModelId, "deepseek");
  // 仅配置的模型必须 has() 通过，避免前端选择后 create 必失败。
  assert.equal(modelRegistry.has("deepseek"), true);
  await app.close();
});
