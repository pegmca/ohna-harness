import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresConversationRepositories,
  createPostgresRunRepository,
  createPostgresTraceStore
} from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("Trace 持久化保证原子 Run 投影、用户隔离、并发 sequence 与写库前脱敏", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    const userTwo = "20000000-0000-4000-8000-000000000002";
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$3,$3,$3),($2,$3,$3,$3)",
      [userOne, userTwo, now]
    );
    const conversations = createPostgresConversationRepositories(context.pool).conversationRepository;
    const conversation = await conversations.create(userOne, {
      id: "10000000-0000-4000-8000-000000000010", title: "Trace tests", now
    });
    const runId = "10000000-0000-4000-8000-000000000100";
    const requestId = "request-trace-1";
    const traceId = "trace-1";
    await createPostgresRunRepository(context.pool).create({
      runId, requestId, userId: userOne, conversationId: conversation.id, message: "研究问题",
      clientMessageId: "trace-client-1", mode: "auto", source: "composer", traceId, createdAt: now
    });
    const store = createPostgresTraceStore(context.pool);
    const traceContext = { userId: userOne, runId, conversationId: conversation.id, traceId, requestId, startedAt: now };
    await store.initialize(traceContext);
    const events = Array.from({ length: 8 }, (_, index) => ({
      type: "tool_call", id: crypto.randomUUID(), traceId, requestId,
      createdAt: `2026-07-25T08:00:0${index}.000Z`, toolName: "search",
      args: {
        authorization: "Bearer raw-session-token",
        email: "owner@example.com",
        document: "x".repeat(900)
      },
      durationMs: index, ok: true
    }));
    const projections = await Promise.all(events.map((event) => store.append(traceContext, event)));
    assert.deepEqual(
      projections.map((event) => event.sequence).sort((left, right) => left - right),
      Array.from({ length: 8 }, (_, index) => index + 1)
    );
    const storedPayload = JSON.stringify((await context.pool.query(
      "select payload from trace_events where trace_id=$1 order by sequence", [traceId]
    )).rows);
    for (const sensitive of ["raw-session-token", "owner@example.com", "x".repeat(600)]) {
      assert.equal(storedPayload.includes(sensitive), false);
    }
    assert.equal(storedPayload.includes("[truncated]"), true);
    const runEvents = await context.pool.query(
      "select id,payload from run_events where run_id=$1 and event_type='trace_event' order by sequence", [runId]
    );
    const traceEvents = await context.pool.query(
      "select id,payload from trace_events where trace_id=$1 order by sequence", [traceId]
    );
    assert.deepEqual(runEvents.rows.map((row) => row.id), traceEvents.rows.map((row) => row.id));
    assert.deepEqual(runEvents.rows.map((row) => row.payload.event), traceEvents.rows.map((row) => row.payload));

    const finalTrace = {
      traceId, requestId, startedAt: now, completedAt: "2026-07-25T08:01:00.000Z",
      summary: {
        status: "succeeded", durationMs: 60000, modelCallCount: 0, toolCallCount: 8,
        retrievalCount: 0, inputTokens: "unknown", outputTokens: "unknown",
        knownTokenTotal: 0, unknownTokenCallCount: 0, errorCount: 0
      },
      events
    };
    await store.finalize(traceContext, finalTrace);
    const reconnectedPool = context.createPool();
    const reconnectedStore = createPostgresTraceStore(reconnectedPool);
    const restored = await reconnectedStore.getByRequestId(userOne, requestId);
    assert.equal(restored.summary.toolCallCount, restored.events.length);
    assert.equal(restored.summary.status, "succeeded");
    assert.equal(await reconnectedStore.getByRequestId(userTwo, requestId), undefined);
    await reconnectedPool.end();

    const comments = await context.pool.query(
      `select column_name,col_description((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass::oid,ordinal_position) as comment
         from information_schema.columns where table_schema=current_schema() and table_name in ('traces','trace_events')`
    );
    assert.equal(comments.rows.length, 28);
    assert.equal(comments.rows.every((row) => typeof row.comment === "string" && row.comment.length > 0), true);
  } finally {
    await context.cleanup();
  }
});
