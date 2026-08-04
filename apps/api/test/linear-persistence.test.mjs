import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  createPostgresArtifactRepository,
  createPostgresConversationRepository,
  createPostgresIdentityRepository,
  createPostgresMessageStore,
  createPostgresRunRepository,
  createPostgresWorkflowRepository
} from "@aiagent/database";
import { runMigrations } from "@aiagent/database";
import { createIdentityService } from "@aiagent/identity";
import { createDataSourceRuntime } from "@aiagent/rag";
import { createApiServer } from "../dist/index.js";
import { createModelRuntimeRegistry } from "../dist/application/model-registry.js";

const { Pool } = pg;
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * 创建独立 schema 的 PG 测试上下文（与 packages/database 的 helper 同模式）。
 *
 * @returns {Promise<{pool: pg.Pool, repos: object, cleanup: () => Promise<void>}>} 测试上下文。
 */
async function createPgContext() {
  const testUrl = process.env.TEST_DATABASE_URL;
  const schema = `aiagent_api_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: testUrl, max: 1 });
  await adminPool.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: testUrl, max: 4, options: `-c search_path=${schema}` });
  await runMigrations(pool);
  return {
    pool,
    repos: {
      conversationRepository: createPostgresConversationRepository(pool),
      messageStore: createPostgresMessageStore(pool),
      runStore: createPostgresRunRepository(pool),
      workflowRepository: createPostgresWorkflowRepository(pool),
      artifactRepository: createPostgresArtifactRepository(pool),
      identityService: createIdentityService(createPostgresIdentityRepository(pool), {
        fingerprintPepper: "linear-persistence-test"
      })
    },
    async cleanup() {
      await pool.end();
      await adminPool.query(`drop schema "${schema}" cascade`);
      await adminPool.end();
    }
  };
}

function createServer(repos, extra = {}) {
  return createApiServer({
    ...repos,
    dataSourceRuntime: createDataSourceRuntime(),
    requireIdentity: true,
    ...extra
  });
}

async function bootstrap(app, visitorId) {
  const response = await app.inject({
    method: "POST", url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return response.headers["set-cookie"].split(";")[0];
}

async function waitForTerminal(app, snapshotUrl, headers) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl, headers });
    const snapshot = response.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Run did not reach terminal state.");
}

function parseSseEvents(body) {
  return body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("(a) run 落库线性消息序列，run_events_v2 与 SSE 输出逐条一致", { skip: !integrationEnabled }, async () => {
  const context = await createPgContext();
  const app = createServer(context.repos);
  try {
    const cookie = await bootstrap(app, "visitor-linear-a");
    const conversation = (await app.inject({
      method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title: "线性" }
    })).json().data;
    const accepted = (await app.inject({
      method: "POST", url: "/api/runs", headers: { cookie },
      payload: { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。", conversationId: conversation.conversationId, mode: "auto", source: "composer" }
    })).json().data;
    const snapshot = await waitForTerminal(app, accepted.snapshotUrl, { cookie });
    assert.equal(snapshot.status, "completed");

    // messages_v2：user → assistant(toolCall) → toolResult → assistant 线性序列。
    const messageRows = (await context.pool.query(
      "select role,message_type,sequence,run_id from messages_v2 where conversation_id=$1 order by sequence",
      [conversation.conversationId]
    )).rows;
    assert.deepEqual(messageRows.map((row) => row.role), ["user", "assistant", "toolResult", "assistant"]);
    assert.deepEqual(messageRows.map((row) => Number(row.sequence)), [1, 2, 3, 4]);
    assert.equal(messageRows.every((row) => row.message_type === "normal"), true);
    assert.equal(messageRows.slice(1).every((row) => row.run_id === accepted.runId), true);

    // run_events_v2 与 SSE 实际输出逐条一致（sequence / type / payload）。
    const storedEvents = (await context.pool.query(
      "select sequence,event_type,payload from run_events_v2 where run_id=$1 order by sequence",
      [accepted.runId]
    )).rows;
    const sse = await app.inject({ method: "GET", url: `${accepted.eventsUrl}?afterSequence=0`, headers: { cookie } });
    const sseEvents = parseSseEvents(sse.body);
    assert.equal(sseEvents.length, storedEvents.length);
    assert.equal(sseEvents.length, snapshot.lastEventSequence);
    for (const [index, stored] of storedEvents.entries()) {
      assert.equal(sseEvents[index].sequence, Number(stored.sequence));
      assert.equal(sseEvents[index].type, stored.event_type);
      assert.deepEqual(sseEvents[index].payload, stored.payload);
    }
    assert.equal(sseEvents[0].type, "run_status");
    assert.equal(sseEvents.at(-1).type, "agent_end");
    assert.equal(sseEvents.some((event) => event.type === "tool_execution_end"), true);
  } finally {
    await app.close();
    await context.cleanup();
  }
});

test("(b) 按最后序号续传不丢不重", { skip: !integrationEnabled }, async () => {
  const context = await createPgContext();
  const app = createServer(context.repos);
  try {
    const cookie = await bootstrap(app, "visitor-linear-b");
    const conversation = (await app.inject({
      method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title: "续传" }
    })).json().data;
    const accepted = (await app.inject({
      method: "POST", url: "/api/runs", headers: { cookie },
      payload: { message: "计算 12*8+4 是多少？", conversationId: conversation.conversationId, mode: "auto", source: "composer" }
    })).json().data;
    const snapshot = await waitForTerminal(app, accepted.snapshotUrl, { cookie });
    assert.equal(snapshot.status, "completed");
    const total = snapshot.lastEventSequence;

    // 全量重放 + 多个游标续传：拼接后必须与全量完全一致，无丢失无重复。
    const full = parseSseEvents((await app.inject({
      method: "GET", url: `${accepted.eventsUrl}?afterSequence=0`, headers: { cookie }
    })).body);
    assert.equal(full.length, total);
    for (const cursor of [1, Math.floor(total / 2), total - 1]) {
      const tail = parseSseEvents((await app.inject({
        method: "GET", url: `${accepted.eventsUrl}?afterSequence=${cursor}`,
        headers: { cookie, "last-event-id": String(cursor) }
      })).body);
      assert.deepEqual(tail.map((event) => event.sequence), full.slice(cursor).map((event) => event.sequence));
      assert.equal(new Set(tail.map((event) => event.sequence)).size, tail.length);
    }
  } finally {
    await app.close();
    await context.cleanup();
  }
});

test("(c) compaction 跨进程生效：重启后上下文从压缩消息重建", { skip: !integrationEnabled }, async () => {
  const context = await createPgContext();
  const capturedContexts = [];
  const capturingStreamFn = (_model, llmContext) => {
    capturedContexts.push(structuredClone(llmContext.messages));
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "好的。" }],
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
      id: "mock", label: "Capturing Mock", provider: "mock", description: "captures llm contexts",
      isDefault: true, capabilities: { structuredOutput: true, toolCalling: true }
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
  // 极小 contextWindow 强制第二轮触发 compaction。
  const compaction = { contextWindow: 40, settings: { reserveTokens: 1, keepRecentTokens: 10 } };

  const appOne = createServer(context.repos, { modelRegistry, compaction });
  const cookie = await bootstrap(appOne, "visitor-linear-c");
  const conversationId = (await appOne.inject({
    method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title: "压缩" }
  })).json().data.conversationId;
  const longMessage = `第一轮问题：${"这是一段用于填充上下文的财务研究描述。".repeat(20)}`;
  const first = (await appOne.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: { message: longMessage, conversationId, mode: "auto", source: "composer" }
  })).json().data;
  await waitForTerminal(appOne, first.snapshotUrl, { cookie });
  // 第二轮：历史超阈值，transformContext 触发压缩并落库 compaction 消息。
  const second = (await appOne.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: { message: "第二轮问题：继续分析。", conversationId, mode: "auto", source: "composer" }
  })).json().data;
  await waitForTerminal(appOne, second.snapshotUrl, { cookie });
  await appOne.close();

  const compactionRows = (await context.pool.query(
    "select content from messages_v2 where conversation_id=$1 and message_type='compaction'",
    [conversationId]
  )).rows;
  assert.equal(compactionRows.length, 1);
  assert.equal(typeof compactionRows[0].content, "string");
  assert.equal(compactionRows[0].content.startsWith("[以下是之前对话历史的压缩摘要]"), true);

  // 模拟重启：同一数据库新建 server（新 runService，无任何内存历史）。
  const appTwo = createServer(context.repos, { modelRegistry, compaction });
  try {
    const cookieTwo = await bootstrap(appTwo, "visitor-linear-c");
    void cookieTwo;
    const third = (await appTwo.inject({
      method: "POST", url: "/api/runs", headers: { cookie },
      payload: { message: "第三轮问题：接着刚才说。", conversationId, mode: "auto", source: "composer" }
    })).json().data;
    await waitForTerminal(appTwo, third.snapshotUrl, { cookie });

    // 第三轮的 LLM 上下文必须从压缩消息重建：首条是 compaction 摘要 user 消息，
    // 第一轮原文不再作为独立消息出现（已顶替为摘要）。
    const thirdContext = capturedContexts.at(-1);
    assert.equal(thirdContext[0].role, "user");
    assert.equal(thirdContext[0].content.startsWith("[以下是之前对话历史的压缩摘要]"), true);
    assert.equal(thirdContext.some((message) => message.content === longMessage), false);
  } finally {
    await appTwo.close();
    await context.cleanup();
  }
});
