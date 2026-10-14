import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPostgresAttachmentRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("附件上传持久化幂等、冲突、失败重试与 orphan 清理", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userId = randomUUID();
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$2,$2,$2)",
      [userId, now]
    );
    const attachments = createPostgresAttachmentRepository(context.pool);
    const input = {
      userId,
      clientAttachmentId: "upload-1",
      checksum: "sha256-content-a",
      fileName: "a.txt",
      contentType: "text/plain",
      sizeBytes: 8
    };
    const initial = await attachments.claim(input, now);
    assert.equal(initial.created, true);
    assert.equal((await attachments.claim({ ...input, fileName: "renamed.txt" }, now)).created, false);
    await assert.rejects(
      attachments.claim({ ...input, checksum: "sha256-content-b" }, now),
      (error) => error.code === "conflict"
    );

    await attachments.fail(userId, input.clientAttachmentId, initial.upload.claimToken, now);
    const retried = await attachments.claim(input, "2026-07-25T08:01:00.000Z");
    assert.equal(retried.created, true);

    // P1 起附件是会话级临时数据：document_id 只是 Redis 附件文档的逻辑 uuid，
    // 不再外键关联 documents，也不产生 documents/document_versions/chunks 行。
    const attachmentDocumentId = randomUUID();
    await attachments.complete(
      userId, input.clientAttachmentId, retried.upload.claimToken, attachmentDocumentId, "2026-07-25T08:01:00.000Z"
    );
    const documents = await context.pool.query(
      "select 1 from documents where id=$1",
      [attachmentDocumentId]
    );
    assert.equal(documents.rowCount, 0);

    // orphan 清理只删除上传记录；Redis 临时索引由 TTL 回收，不再软删 documents。
    assert.equal(await attachments.cleanupOrphans("2026-07-26T08:00:00.000Z", 100, "2026-07-26T08:00:00.000Z"), 1);
    const remaining = await context.pool.query(
      "select 1 from chat_attachment_uploads where user_id=$1 and client_attachment_id=$2",
      [userId, input.clientAttachmentId]
    );
    assert.equal(remaining.rowCount, 0);
  } finally {
    await context.cleanup();
  }
});

test("uploading 租约到期后可接管，旧执行者不能 complete", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userId = randomUUID();
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$2,$2,$2)",
      [userId, now]
    );
    const attachments = createPostgresAttachmentRepository(context.pool);
    const input = {
      userId,
      clientAttachmentId: "crashed-upload",
      checksum: "same-content",
      fileName: "lease.txt",
      contentType: "text/plain",
      sizeBytes: 4
    };
    const crashed = await attachments.claim(input, now);
    assert.equal((await attachments.claim(input, "2026-07-25T08:14:59.000Z")).created, false);
    const takeover = await attachments.claim(input, "2026-07-25T08:15:01.000Z");
    assert.equal(takeover.created, true);
    assert.notEqual(takeover.upload.claimToken, crashed.upload.claimToken);
    await assert.rejects(
      attachments.complete(
        userId, input.clientAttachmentId, crashed.upload.claimToken, randomUUID(), "2026-07-25T08:01:02.000Z"
      ),
      (error) => error.code === "conflict"
    );
  } finally {
    await context.cleanup();
  }
});

test("原执行者续租期间不能被接管，续租停止并到期后才允许接管", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userId = randomUUID();
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$2,$2,$2)",
      [userId, now]
    );
    const attachments = createPostgresAttachmentRepository(context.pool);
    const input = {
      userId,
      clientAttachmentId: "slow-upload",
      checksum: "slow-content",
      fileName: "slow.txt",
      contentType: "text/plain",
      sizeBytes: 4
    };
    const running = await attachments.claim(input, now);
    assert.equal(
      await attachments.renew(
        userId, input.clientAttachmentId, running.upload.claimToken, "2026-07-25T08:10:00.000Z"
      ),
      true
    );
    assert.equal((await attachments.claim(input, "2026-07-25T08:16:00.000Z")).created, false);
    const takeover = await attachments.claim(input, "2026-07-25T08:25:01.000Z");
    assert.equal(takeover.created, true);
    assert.equal(
      await attachments.renew(
        userId, input.clientAttachmentId, running.upload.claimToken, "2026-07-25T08:25:02.000Z"
      ),
      false
    );
  } finally {
    await context.cleanup();
  }
});
