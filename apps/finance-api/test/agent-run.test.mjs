import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";
import { createInMemoryApiTestRuntime } from "../dist/adapters/in-memory-test-runtime.js";
import { createModelRuntimeRegistry } from "../dist/application/model-registry.js";

async function bootstrap(app, visitorId) {
  const response = await app.inject({
    method: "POST", url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return response.headers["set-cookie"].split(";")[0];
}

async function createConversation(app, cookie, title = "测试会话") {
  const response = await app.inject({
    method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title }
  });
  assert.equal(response.statusCode, 201);
  return response.json().data.conversationId;
}

async function waitForTerminal(app, snapshotUrl, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl, headers });
    const snapshot = response.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("health and readiness separate liveness from dependency readiness", async () => {
  const app = createApiServer({
    ...createInMemoryApiTestRuntime(),
    readiness: async () => ({ ok: false, dependency: "test-provider", message: "not configured" })
  });
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 503);
  await app.close();
});

test("model catalog exposes stable provider but not provider model name", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const response = await app.inject({ method: "GET", url: "/api/models" });
  assert.equal(response.statusCode, 200);
  // 离线集成测试注入的是测试替身（test-double），不再断言已移除的运行时 mock。
  // 断言目录暴露了稳定可用且为默认的测试替身模型，且目录不向下发 provider 内部 model 名。
  const catalog = response.json().data;
  assert.equal(catalog.defaultModelId, "test-double");
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, "test-double");
  assert.equal(catalog.models.some((model) => model.id === catalog.defaultModelId), true);
  assert.equal("model" in catalog.models[0], false);
  await app.close();
});

test("POST /api/runs validates the new run creation contract", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const invalid = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { message: "hello" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "validation_failed");
  await app.close();
});

test("同一 conversationId 连续两个 run，第二个 run 的上下文包含第一轮消息", async () => {
  // 用捕获型 streamFn 记录每次 LLM 调用的上下文，验证历史从 messageStore 投影重建（不再是内存累积）。
  const capturedContexts = [];
  const capturingStreamFn = (_model, context) => {
    capturedContexts.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
    const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
    const text = `回答：${typeof lastUser?.content === "string" ? lastUser.content : ""}`;
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "mock",
      model: "capturing-mock",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    };
    const events = [{ type: "start", partial: { ...message, content: [] } }, { type: "done", reason: "stop", message }];
    return {
      async *[Symbol.asyncIterator]() { yield* events; },
      async result() { return message; }
    };
  };
  const modelRegistry = createModelRuntimeRegistry([{
    option: {
      id: "mock",
      label: "Capturing Mock",
      provider: "mock",
      description: "captures llm contexts",
      isDefault: true,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: {
      model: {
        id: "capturing-mock", name: "Capturing Mock", api: "openai-completions", provider: "mock",
        baseUrl: "http://localhost/mock", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 4096
      },
      streamFn: capturingStreamFn
    }
  }], "mock");
  const runtime = createInMemoryApiTestRuntime();
  const app = createApiServer({ ...runtime, modelRegistry, requireIdentity: true });
  const cookie = await bootstrap(app, "visitor-history-0001");
  const conversationId = await createConversation(app, cookie);
  const payload = (message) => ({ message, conversationId, mode: "auto", source: "composer" });

  const first = (await app.inject({ method: "POST", url: "/api/runs", headers: { cookie }, payload: payload("第一轮问题") })).json().data;
  const firstSnapshot = await waitForTerminal(app, first.snapshotUrl, { cookie });
  assert.equal(firstSnapshot.status, "completed");

  const second = (await app.inject({ method: "POST", url: "/api/runs", headers: { cookie }, payload: payload("第二轮问题") })).json().data;
  const secondSnapshot = await waitForTerminal(app, second.snapshotUrl, { cookie });
  assert.equal(secondSnapshot.status, "completed");

  assert.equal(capturedContexts.length, 2);
  const secondTurnMessages = capturedContexts[1].messages;
  // 第二轮上下文必须包含第一轮 user 与 assistant 消息（历史从 messages 投影重建）。
  assert.equal(
    secondTurnMessages.some((message) => message.role === "user" && message.content === "第一轮问题"),
    true
  );
  assert.equal(
    secondTurnMessages.some(
      (message) => message.role === "assistant"
        && message.content.some((block) => block.type === "text" && block.text === "回答：第一轮问题")
    ),
    true
  );
  await app.close();
});

test("run 产生线性消息序列与连续的 canonical 事件流", async () => {
  const runtime = createInMemoryApiTestRuntime();
  const app = createApiServer({ ...runtime, requireIdentity: true });
  const cookie = await bootstrap(app, "visitor-run-0001");
  const conversationId = await createConversation(app, cookie);
  const acceptedResponse = await app.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。", conversationId, mode: "auto", source: "composer" }
  });
  assert.equal(acceptedResponse.statusCode, 202);
  const accepted = acceptedResponse.json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl, { cookie });

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.lastEventSequence > 0, true);

  // 事件流：sequence 从 1 连续，首事件 run_status(queued)，末事件 agent_end。
  const events = await app.inject({ method: "GET", url: `${accepted.eventsUrl}?afterSequence=0`, headers: { cookie } });
  const streamEvents = events.body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(streamEvents.map((event) => event.sequence), streamEvents.map((_, index) => index + 1));
  assert.equal(streamEvents[0].type, "run_status");
  assert.equal(streamEvents.at(-1).type, "agent_end");
  // mock 模型该提问会触发工具调用：事件流含 tool_execution_* 与多 turn。
  assert.equal(streamEvents.some((event) => event.type === "tool_execution_start"), true);
  assert.equal(streamEvents.some((event) => event.type === "message_update"), true);

  // 消息列表：user → assistant(toolCall) → toolResult → assistant 线性序列。
  const messages = await app.inject({
    method: "GET", url: `/api/conversations/${conversationId}/messages`, headers: { cookie }
  });
  const items = messages.json().data.items;
  assert.deepEqual(items.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.deepEqual(items.map((message) => message.sequence), [1, 2, 3, 4]);
  // assistant 消息 content 为块数组原样透传；toolResult 为 envelope。
  assert.equal(items[1].content[0].type, "toolCall");
  assert.equal(items[2].content.toolCallId, items[1].content[0].id);
  assert.equal(items.every((message) => message.messageType === "normal"), true);
  await app.close();
});

test("SSE 终态 replay 支持 Last-Event-ID 与 afterSequence，且不重复业务事件", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const cookie = await bootstrap(app, "visitor-replay-0001");
  const conversationId = await createConversation(app, cookie);
  const accepted = (await app.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: { message: "hello", conversationId, mode: "auto", source: "composer" }
  })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl, { cookie });
  const total = snapshot.lastEventSequence;
  const after = Math.max(0, total - 3);
  const replay = await app.inject({
    method: "GET",
    url: `${accepted.eventsUrl}?afterSequence=${after - 1}`,
    headers: { cookie, "last-event-id": String(after) }
  });
  assert.equal(replay.statusCode, 200);
  const events = replay.body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: total - after }, (_, index) => after + index + 1));
  assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  assert.equal(["agent_end", "run_error"].includes(events.at(-1).type), true);
  await app.close();
});

test("重复 clientMessageId 复用同一 Run，且 Run API 对用户隐藏其他用户资源", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const cookieOne = await bootstrap(app, "visitor-run-owner-0001");
  const cookieTwo = await bootstrap(app, "visitor-run-owner-0002");
  const conversationId = await createConversation(app, cookieOne);
  const payload = { message: "查询净利润", conversationId, clientMessageId: "client-idempotency-1", mode: "auto", source: "composer" };
  const first = await app.inject({ method: "POST", url: "/api/runs", headers: { cookie: cookieOne }, payload });
  const duplicate = await app.inject({ method: "POST", url: "/api/runs", headers: { cookie: cookieOne }, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(first.json().data.runId, duplicate.json().data.runId);

  const runId = first.json().data.runId;
  for (const request of [
    { method: "GET", url: `/api/runs/${runId}` },
    { method: "DELETE", url: `/api/runs/${runId}` },
    { method: "GET", url: `/api/runs/${runId}/events` }
  ]) {
    const response = await app.inject({ ...request, headers: { cookie: cookieTwo } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  }
  await app.close();
});

test("run snapshot returns structured not_found errors", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const response = await app.inject({ method: "GET", url: "/api/runs/missing" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
  await app.close();
});

test("data sources and RAG routes retain structured DTO boundaries", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const ingest = await app.inject({
    method: "POST",
    url: "/api/data-sources/ingest",
    payload: {
      source: "demo",
      fileName: "annual-report.md",
      content: "# 资产质量\n公司不良率保持稳定。\n\n# 盈利能力\n净利润同比增长。"
    }
  });
  assert.equal(ingest.statusCode, 200);
  assert.equal(ingest.json().data.documentVersion, 1);
  assert.equal(ingest.json().data.deduplicated, false);

  const documents = await app.inject({ method: "GET", url: "/api/data-sources/documents" });
  assert.equal(documents.statusCode, 200);
  assert.equal(documents.json().data.nextCursor, null);
  assert.equal(documents.json().data.documents.length, 1);
  assert.equal(documents.json().data.documents[0].latestVersion, 1);
  assert.equal(documents.json().data.documents[0].latestStatus, "indexed");
  assert.equal(documents.json().data.documents[0].scope, "shared");

  const chunks = await app.inject({ method: "GET", url: "/api/data-sources/chunks" });
  assert.equal(chunks.statusCode, 200);
  assert.equal(chunks.json().data.nextCursor, null);
  assert.equal(chunks.json().data.chunks.length, ingest.json().data.indexedChunkCount);

  const answer = await app.inject({
    method: "POST",
    url: "/api/rag/answer",
    payload: { question: "公司资产质量如何？", topK: 5 }
  });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.json().data.answer.citations.length > 0, true);
  await app.close();
});

test("data sources ingest rejects unsafe source identifiers", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const unsafeSources = ["/etc/passwd", "file:///etc/passwd", "../x", "C:\\data\\x.md", "~/secret.md"];

  for (const source of unsafeSources) {
    const response = await app.inject({
      method: "POST",
      url: "/api/data-sources/ingest",
      payload: {
        source,
        fileName: "annual-report.md",
        content: "# 资产质量\n公司不良率保持稳定。"
      }
    });
    assert.equal(response.statusCode, 400, `source ${source} should be rejected`);
    assert.equal(response.json().error.code, "validation_failed");
  }

  const documents = await app.inject({ method: "GET", url: "/api/data-sources/documents" });
  assert.equal(documents.json().data.documents.length, 0);
  await app.close();
});

test("data sources list routes validate pagination query and page through results", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  for (let index = 0; index < 3; index += 1) {
    const ingest = await app.inject({
      method: "POST",
      url: "/api/data-sources/ingest",
      payload: {
        source: `demo/doc-${index}`,
        fileName: `doc-${index}.md`,
        content: `# 文档 ${index}\n第 ${index} 篇内容。`
      }
    });
    assert.equal(ingest.statusCode, 200);
  }

  const invalid = await app.inject({ method: "GET", url: "/api/data-sources/documents?limit=0" });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "validation_failed");

  const seen = new Set();
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const url = cursor
      ? `/api/data-sources/documents?limit=2&cursor=${encodeURIComponent(cursor)}`
      : "/api/data-sources/documents?limit=2";
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    response.json().data.documents.forEach((document) => seen.add(document.documentId));
    if (!response.json().data.nextCursor) break;
    cursor = response.json().data.nextCursor;
  }
  assert.equal(seen.size, 3);
  await app.close();
});

test("product evidence routes remain readable", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const evalResponse = await app.inject({ method: "GET", url: "/api/product/eval-report" });
  const architecture = await app.inject({ method: "GET", url: "/api/product/architecture" });
  assert.equal(evalResponse.json().data.caseCount, 31);
  assert.equal(architecture.json().data.nodes.some((node) => node.label === "apps/finance-api"), true);
  await app.close();
});
