import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresConversationRepositories } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

test("Conversation 与 Message PostgreSQL adapter 满足归属、分页、归档和并发语义", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    const userTwo = "20000000-0000-4000-8000-000000000002";
    const now = "2026-07-25T08:00:00.000Z";
    await context.pool.query(
      `insert into users(id,created_at,updated_at,last_seen_at)
       values ($1,$3,$3,$3),($2,$3,$3,$3)`,
      [userOne, userTwo, now]
    );
    const { conversationRepository, messageRepository } = createPostgresConversationRepositories(context.pool);

    const conversationIds = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001"
    ];
    for (const [index, id] of conversationIds.entries()) {
      await conversationRepository.create(userOne, { id, title: `会话 ${index + 1}`, now });
    }
    const foreign = await conversationRepository.create(userTwo, {
      id: "20000000-0000-4000-8000-000000000003",
      title: "其他用户",
      now
    });

    assert.equal(await conversationRepository.find(userOne, foreign.id), undefined);
    await assert.rejects(
      () => conversationRepository.updateTitle(userOne, foreign.id, "越权"),
      (error) => error.code === "not_found"
    );
    await assert.rejects(
      () => conversationRepository.archive(userOne, foreign.id),
      (error) => error.code === "not_found"
    );

    const firstPage = await conversationRepository.list(userOne, { limit: 2 });
    const secondPage = await conversationRepository.list(userOne, { limit: 2, cursor: firstPage.nextCursor });
    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map((item) => item.id),
      conversationIds
    );
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 3);

    const archivedOnce = await conversationRepository.archive(userOne, conversationIds[0], "2026-07-25T09:00:00.000Z");
    const archivedTwice = await conversationRepository.archive(userOne, conversationIds[0], "2026-07-25T10:00:00.000Z");
    assert.equal(archivedOnce.archivedAt, archivedTwice.archivedAt);
    assert.equal((await conversationRepository.find(userOne, conversationIds[0]))?.status, "archived");
    assert.equal((await conversationRepository.list(userOne)).items.some((item) => item.id === conversationIds[0]), false);

    const idempotentInput = {
      conversationId: conversationIds[1],
      role: "user",
      content: "同一条客户端消息",
      status: "completed",
      clientMessageId: "client-message-1",
      createdAt: "2026-07-25T11:00:00.000Z"
    };
    const duplicateResults = await Promise.all(
      Array.from({ length: 8 }, () => messageRepository.appendUserMessageIdempotently(userOne, idempotentInput))
    );
    assert.equal(duplicateResults.filter((result) => result.outcome === "created").length, 1);
    assert.equal(new Set(duplicateResults.map((result) => result.message.id)).size, 1);

    const concurrentMessages = await Promise.all(
      Array.from({ length: 8 }, (_, index) => messageRepository.append(userOne, {
        conversationId: conversationIds[1],
        role: "assistant",
        content: `并发消息 ${index}`,
        status: "completed",
        createdAt: "2026-07-25T11:01:00.000Z"
      }))
    );
    assert.deepEqual(
      concurrentMessages.map((message) => message.sequence).sort((left, right) => left - right),
      [2, 3, 4, 5, 6, 7, 8, 9]
    );
    assert.equal(new Set(concurrentMessages.map((message) => message.sequence)).size, 8);
    assert.equal(await messageRepository.find(userTwo, concurrentMessages[0].id), undefined);
    assert.deepEqual((await messageRepository.list(userOne, { conversationId: conversationIds[1], limit: 4 })).items.map(
      (message) => message.sequence
    ), [1, 2, 3, 4]);

    const columns = await context.pool.query(
      `select table_name,column_name,col_description((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass::oid,ordinal_position) as comment
         from information_schema.columns
        where table_schema=current_schema() and table_name in ('conversations','messages')`
    );
    assert.equal(columns.rows.length, 19);
    assert.equal(columns.rows.every((row) => typeof row.comment === "string" && row.comment.length > 0), true);
  } finally {
    await context.cleanup();
  }
});
