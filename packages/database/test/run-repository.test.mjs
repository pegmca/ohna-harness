import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresConversationRepositories, createPostgresRunRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("Run repository 保证事务 sequence、幂等创建、终态 CAS、恢复与用户隔离", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    const userTwo = "20000000-0000-4000-8000-000000000002";
    await context.pool.query(
      `insert into users(id,created_at,updated_at,last_seen_at)
       values ($1,$3,$3,$3),($2,$3,$3,$3)`,
      [userOne, userTwo, now]
    );
    const conversations = createPostgresConversationRepositories(context.pool).conversationRepository;
    const conversationOne = await conversations.create(userOne, {
      id: "10000000-0000-4000-8000-000000000010", title: "Run tests", now
    });
    const conversationTwo = await conversations.create(userTwo, {
      id: "20000000-0000-4000-8000-000000000020", title: "Foreign", now
    });
    const repository = createPostgresRunRepository(context.pool);
    const input = {
      runId: "10000000-0000-4000-8000-000000000100",
      requestId: `${userOne}:client-1`,
      userId: userOne,
      conversationId: conversationOne.id,
      message: "研究问题",
      clientMessageId: "client-1",
      modelId: "mock",
      attachmentDocumentIds: [],
      mode: "auto",
      source: "composer",
      traceId: "trace-1",
      createdAt: now
    };
    const [first, duplicate] = await Promise.all([repository.create(input), repository.create(input)]);
    assert.equal([first, duplicate].filter((result) => result.created).length, 1);
    assert.equal(first.snapshot.runId, duplicate.snapshot.runId);
    const messageCount = await context.pool.query(
      "select role,count(*)::integer as count from messages where run_id=$1 group by role order by role",
      [input.runId]
    );
    assert.deepEqual(messageCount.rows, [{ role: "assistant", count: 1 }, { role: "user", count: 1 }]);

    const base = {
      runId: input.runId, requestId: input.requestId, traceId: input.traceId,
      conversationId: input.conversationId, createdAt: "2026-07-25T08:01:00.000Z"
    };
    const appended = await Promise.all(Array.from({ length: 12 }, (_, index) => repository.append(
      userOne, input.runId, { ...base, type: "run_status", status: "running", message: `event-${index}` }
    )));
    assert.deepEqual(appended.map((event) => event.sequence).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));

    const result = {
      runId: input.runId, conversationId: input.conversationId, requestId: input.requestId,
      traceId: input.traceId, ok: true, intent: "chat", answer: "done", steps: [],
      trace: { traceId: input.traceId, requestId: input.requestId, startedAt: now, status: "succeeded", events: [],
        summary: { modelCalls: 0, toolCalls: 0, retrievalCalls: 0, workflowNodes: 0, durationMs: 0, tokenUsage: "unknown", errorCount: 0 } }
    };
    const terminal = await Promise.all([
      repository.append(userOne, input.runId, { ...base, type: "run_result", result }),
      repository.append(userOne, input.runId, {
        ...base, type: "run_error", error: { code: "request_cancelled", message: "cancelled", requestId: input.requestId }
      })
    ]);
    assert.equal(terminal.filter(Boolean).length, 1);
    assert.equal(["succeeded", "cancelled"].includes((await repository.findById(userOne, input.runId)).status), true);
    assert.equal(await repository.findById(userTwo, input.runId), undefined);
    assert.equal(await repository.listEvents(userTwo, input.runId, 0), undefined);

    const staleInput = {
      ...input, runId: "10000000-0000-4000-8000-000000000101",
      requestId: `${userOne}:client-stale`, clientMessageId: "client-stale",
      createdAt: "2026-07-25T06:00:00.000Z"
    };
    await repository.create(staleInput);
    const recovered = await repository.recoverStale("2026-07-25T07:00:00.000Z", "2026-07-25T09:00:00.000Z");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].type, "run_error");
    assert.equal(recovered[0].error.code, "run_interrupted");

    await assert.rejects(
      () => repository.create({ ...input, runId: "20000000-0000-4000-8000-000000000100", requestId: "foreign", userId: userOne, conversationId: conversationTwo.id }),
      (error) => error.code === "not_found"
    );

    const comments = await context.pool.query(
      `select table_name,column_name,col_description((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass::oid,ordinal_position) as comment
         from information_schema.columns where table_schema=current_schema() and table_name in ('agent_runs','run_events')`
    );
    assert.equal(comments.rows.length, 29);
    assert.equal(comments.rows.every((row) => typeof row.comment === "string" && row.comment.length > 0), true);
  } finally {
    await context.cleanup();
  }
});
