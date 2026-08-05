import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresConversationRepository, createPostgresRunRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("Run v2 repository 保证幂等创建、事件 sequence、终态推导、续传与恢复", { skip: !integrationEnabled }, async () => {
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
    const conversations = createPostgresConversationRepository(context.pool);
    const conversation = await conversations.create(userOne, {
      id: "10000000-0000-4000-8000-000000000010", title: "Run tests", now
    });
    const repository = createPostgresRunRepository(context.pool);
    const input = {
      runId: "10000000-0000-4000-8000-000000000100",
      requestId: `${userOne}:client-1`,
      userId: userOne,
      conversationId: conversation.id,
      message: "研究问题",
      clientMessageId: "client-1",
      modelId: "mock",
      mode: "auto",
      source: "composer",
      createdAt: now
    };

    // 幂等创建：并发同 requestId 只创建一个 Run，用户消息只落一条。
    const [first, duplicate] = await Promise.all([repository.create(input), repository.create(input)]);
    assert.equal([first, duplicate].filter((result) => result.created).length, 1);
    assert.equal(first.snapshot.runId, duplicate.snapshot.runId);
    assert.equal(first.snapshot.status, "queued");
    const messageRows = await context.pool.query(
      "select role,content from messages where conversation_id=$1",
      [conversation.id]
    );
    assert.equal(messageRows.rows.length, 1);
    assert.equal(messageRows.rows[0].role, "user");

    const base = {
      runId: input.runId, requestId: input.requestId,
      conversationId: input.conversationId, createdAt: "2026-07-25T08:01:00.000Z"
    };
    // 并发 append run_status running：同事务行锁串行分配 sequence，重复同态事件允许但序号唯一。
    const runningEvents = await Promise.all(Array.from({ length: 3 }, () => repository.appendEvent(
      userOne, input.runId, { ...base, type: "run_status", payload: { status: "running", message: "开始" } }
    )));
    assert.deepEqual(runningEvents.map((event) => event.sequence).sort((a, b) => a - b), [1, 2, 3]);

    // loop 事件连续分配 sequence。
    const appended = await Promise.all([
      repository.appendEvent(userOne, input.runId, { ...base, type: "agent_start", payload: { type: "agent_start" } }),
      repository.appendEvent(userOne, input.runId, { ...base, type: "turn_start", payload: { type: "turn_start" } }),
      repository.appendEvent(userOne, input.runId, { ...base, type: "message_start", payload: { type: "message_start", message: { role: "user" } } })
    ]);
    assert.deepEqual(appended.map((event) => event.sequence).sort((a, b) => a - b), [4, 5, 6]);

    // agent_end 推导 completed 并推进高水位；终态后 append 拒绝。
    const end = await repository.appendEvent(userOne, input.runId, {
      ...base, type: "agent_end",
      payload: { type: "agent_end", messages: [{ role: "user", content: "研究问题", timestamp: 1 }, { role: "assistant", stopReason: "stop" }] }
    });
    assert.equal(end.sequence, 7);
    const snapshot = await repository.findById(userOne, input.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.lastEventSequence, 7);
    assert.ok(snapshot.completedAt);
    assert.equal(await repository.appendEvent(userOne, input.runId, { ...base, type: "turn_start", payload: {} }), undefined);

    // 续传：afterSequence 之后的事件完整升序返回，envelope 字段齐全。
    const events = await repository.listEvents(userOne, input.runId, 4);
    assert.deepEqual(events.map((event) => event.sequence), [5, 6, 7]);
    assert.equal(events[0].requestId, input.requestId);
    assert.equal(events[0].conversationId, conversation.id);

    // 归属隔离：其他用户读不到快照与事件。
    assert.equal(await repository.findById(userTwo, input.runId), undefined);
    assert.equal(await repository.listEvents(userTwo, input.runId, 0), undefined);
  } finally {
    await context.cleanup();
  }
});

test("Run v2 取消与异常推导：aborted→cancelled、run_error→failed、recoverStale→interrupted", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$2,$2,$2)",
      [userOne, now]
    );
    const conversations = createPostgresConversationRepository(context.pool);
    const conversation = await conversations.create(userOne, { title: "状态机", now });
    const repository = createPostgresRunRepository(context.pool);
    const makeInput = (suffix) => ({
      runId: `10000000-0000-4000-8000-0000000001${suffix}`,
      requestId: `${userOne}:client-${suffix}`,
      userId: userOne,
      conversationId: conversation.id,
      message: `问题 ${suffix}`,
      clientMessageId: `client-${suffix}`,
      modelId: "mock",
      mode: "auto",
      source: "composer",
      createdAt: now
    });
    const eventBase = (input) => ({
      runId: input.runId, requestId: input.requestId,
      conversationId: input.conversationId, createdAt: "2026-07-25T08:02:00.000Z"
    });

    // aborted 的 agent_end → cancelled。
    const cancelled = makeInput("10");
    await repository.create(cancelled);
    await repository.appendEvent(userOne, cancelled.runId, {
      ...eventBase(cancelled), type: "agent_end",
      payload: { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }
    });
    const cancelledSnapshot = await repository.findById(userOne, cancelled.runId);
    assert.equal(cancelledSnapshot.status, "cancelled");
    assert.equal(cancelledSnapshot.error.code, "request_cancelled");

    // run_error → failed。
    const failed = makeInput("11");
    await repository.create(failed);
    await repository.appendEvent(userOne, failed.runId, {
      ...eventBase(failed), type: "run_error",
      payload: { error: { code: "internal_error", message: "失败", requestId: failed.requestId } }
    });
    assert.equal((await repository.findById(userOne, failed.runId)).status, "failed");

    // recoverStale：非终态且 updated_at 早于阈值 → interrupted + run_status 事件。
    const stale = makeInput("12");
    await repository.create(stale);
    const recovered = await repository.recoverStale("2026-07-26T00:00:00.000Z", "2026-07-26T00:00:01.000Z");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].type, "run_status");
    assert.equal(recovered[0].payload.status, "interrupted");
    assert.equal((await repository.findById(userOne, stale.runId)).status, "interrupted");
  } finally {
    await context.cleanup();
  }
});
