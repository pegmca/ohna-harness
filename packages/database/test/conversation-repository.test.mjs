import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresConversationRepository, createPostgresMessageStore } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("Conversation v2 CRUD 满足归属、分页、归档语义", { skip: !integrationEnabled }, async () => {
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
    const repository = createPostgresConversationRepository(context.pool);

    const created = await repository.create(userOne, { title: "研究会话", now });
    assert.equal(created.status, "active");

    // 归属隔离：其他用户读不到、改不了。
    assert.equal(await repository.find(userTwo, created.id), undefined);
    await assert.rejects(() => repository.updateTitle(userTwo, created.id, "x"), /not found/i);

    const renamed = await repository.updateTitle(userOne, created.id, "新标题", "2026-07-25T09:00:00.000Z");
    assert.equal(renamed.title, "新标题");

    // 分页：再建两条，limit=1 翻页读完。
    await repository.create(userOne, { title: "会话 2", now: "2026-07-25T10:00:00.000Z" });
    await repository.create(userOne, { title: "会话 3", now: "2026-07-25T11:00:00.000Z" });
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await repository.list(userOne, { limit: 1, cursor });
      result.items.forEach((item) => seen.add(item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    assert.equal(seen.size, 3);

    const archived = await repository.archive(userOne, created.id, "2026-07-25T12:00:00.000Z");
    assert.equal(archived.status, "archived");
    const listed = await repository.list(userOne, { status: "active" });
    assert.equal(listed.items.some((item) => item.id === created.id), false);
  } finally {
    await context.cleanup();
  }
});

test("MessageStore v2 线性 append、幂等、时间线分页与 listForContext 投影", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$2,$2,$2)",
      [userOne, now]
    );
    const conversations = createPostgresConversationRepository(context.pool);
    const conversation = await conversations.create(userOne, { title: "线性消息", now });
    const store = createPostgresMessageStore(context.pool);

    // 幂等用户消息：重复 client_message_id 返回既有行不占新 sequence。
    const first = await store.appendUserMessageIdempotently(userOne, {
      conversationId: conversation.id, role: "user", content: "第一轮问题", clientMessageId: "c-1", createdAt: now
    });
    const duplicate = await store.appendUserMessageIdempotently(userOne, {
      conversationId: conversation.id, role: "user", content: "第一轮问题", clientMessageId: "c-1", createdAt: now
    });
    assert.equal(first.outcome, "created");
    assert.equal(duplicate.outcome, "existing");
    assert.equal(first.message.id, duplicate.message.id);
    assert.equal(first.message.sequence, 1);

    // assistant（content 块数组 + usage）与 toolResult（envelope）线性追加。
    const assistant = await store.append(userOne, {
      conversationId: conversation.id, role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "calculator", arguments: { expression: "1+1" } }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      modelId: "mock", stopReason: "toolUse", createdAt: now
    });
    const toolResult = await store.append(userOne, {
      conversationId: conversation.id, role: "toolResult",
      content: { toolCallId: "call-1", toolName: "calculator", content: [{ type: "text", text: "2" }], isError: false },
      createdAt: now
    });
    assert.deepEqual([assistant.sequence, toolResult.sequence], [2, 3]);

    // 时间线分页：limit=2 翻页读完全部 3 条 + 后续 compaction 行。
    await store.append(userOne, {
      conversationId: conversation.id, role: "user", messageType: "compaction",
      content: "[以下是之前对话历史的压缩摘要]\n\n用户问了 1+1。", createdAt: now
    });
    await store.append(userOne, {
      conversationId: conversation.id, role: "user", content: "压缩后的新问题", clientMessageId: "c-2", createdAt: now
    });
    const seen = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list(userOne, { conversationId: conversation.id, limit: 2, cursor });
      seen.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    assert.deepEqual(seen.map((item) => item.sequence), [1, 2, 3, 4, 5]);
    assert.equal(seen[3].messageType, "compaction");

    // listForContext 投影：最后一个 compaction + 其后消息。
    const projected = await store.listForContext(userOne, conversation.id);
    assert.deepEqual(projected.map((item) => item.sequence), [4, 5]);
    assert.equal(projected[0].messageType, "compaction");

    // 归属隔离：其他用户读不到投影。
    const foreign = await store.listForContext("20000000-0000-4000-8000-000000000002", conversation.id);
    assert.deepEqual(foreign, []);
  } finally {
    await context.cleanup();
  }
});
