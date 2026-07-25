import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPostgresRagDocumentRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * 创建 saveIngestion 测试输入，默认 shared 匿名文档、两个 indexed chunks。
 *
 * @param {object} overrides 需要覆盖的字段。
 * @returns {object} saveIngestion 输入。
 */
function createIngestionInput(overrides = {}) {
  return {
    ownerUserId: null,
    scope: "shared",
    sourceType: "mock_text",
    externalId: `ext-${randomUUID()}`,
    title: "示例文档",
    sourceUri: "demo/source",
    contentType: "text/markdown",
    contentChecksum: `checksum-${randomUUID()}`,
    content: "# 资产质量\n公司不良率保持稳定。",
    parserVersion: "filings-markdown-txt-v1",
    chunkerVersion: "heading-aware-1200-150-v1",
    outcome: {
      status: "indexed",
      chunks: [createChunk(0, "资产质量保持稳健。"), createChunk(1, "净利润同比增长。")]
    },
    now: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

/**
 * 创建待持久化 chunk 测试记录。
 *
 * @param {number} chunkIndex chunk 序号。
 * @param {string} text chunk 文本。
 * @returns {object} NewRagChunkRecord。
 */
function createChunk(chunkIndex, text) {
  return {
    chunkIndex,
    text,
    heading: "资产质量",
    metadata: { charStart: 0, charEnd: text.length, startOffset: 0, endOffset: text.length },
    contentChecksum: `chunk-${chunkIndex}-${text}`
  };
}

/**
 * 创建已执行 migration 的测试上下文和 repository。
 *
 * @returns {Promise<{context: object, repository: object}>} 测试夹具。
 */
async function createRagFixture() {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  await runMigrations(context.pool, join(packageDir, "migrations"));
  return { context, repository: createPostgresRagDocumentRepository(context.pool) };
}

/**
 * 插入测试用户，满足 documents.owner_user_id 外键。
 *
 * @param {object} pool 连接池。
 * @param {string} userId 用户 id。
 * @returns {Promise<void>} 插入完成 Promise。
 */
async function insertUser(pool, userId) {
  await pool.query("insert into users(id, created_at, updated_at, last_seen_at) values ($1, $2, $2, $2)", [
    userId,
    "2026-01-01T00:00:00.000Z"
  ]);
}

test("saveIngestion 幂等命中、版本递增与失败重试", { skip: !integrationEnabled }, async () => {
  const { context, repository } = await createRagFixture();
  try {
    const input = createIngestionInput();
    const created = await repository.saveIngestion(input);
    assert.equal(created.kind, "created");
    assert.equal(created.version.version, 1);
    assert.equal(created.version.status, "indexed");
    assert.equal(created.chunks.length, 2);
    assert.equal(created.chunks[0].chunkId, `${created.document.id}_chunk_0000`);

    const deduplicated = await repository.saveIngestion(input);
    assert.equal(deduplicated.kind, "existing");
    assert.equal(deduplicated.document.id, created.document.id);
    assert.equal(deduplicated.chunks.length, 2);

    const nextVersion = await repository.saveIngestion(
      createIngestionInput({
        externalId: input.externalId,
        contentChecksum: "checksum-v2",
        now: "2026-01-02T00:00:00.000Z"
      })
    );
    assert.equal(nextVersion.kind, "created");
    assert.equal(nextVersion.version.version, 2);
    assert.equal(nextVersion.document.id, created.document.id);

    const failed = await repository.saveIngestion(
      createIngestionInput({
        externalId: input.externalId,
        contentChecksum: "checksum-v3",
        outcome: { status: "failed", error: { code: "empty_file", message: "公告/财报文件内容为空。" } },
        now: "2026-01-03T00:00:00.000Z"
      })
    );
    assert.equal(failed.kind, "created");
    assert.equal(failed.version.status, "failed");
    assert.equal(failed.version.error.code, "empty_file");
    assert.equal(failed.chunks.length, 0);

    const retried = await repository.saveIngestion(
      createIngestionInput({
        externalId: input.externalId,
        contentChecksum: "checksum-v3",
        now: "2026-01-04T00:00:00.000Z"
      })
    );
    assert.equal(retried.kind, "retried");
    assert.equal(retried.version.version, 3);
    assert.equal(retried.version.status, "indexed");
    assert.equal(retried.version.error, undefined);
    assert.equal(retried.version.indexedAt, "2026-01-04T00:00:00.000Z");
    assert.equal(retried.chunks.length, 2);

    const versions = await repository.listVersions({ documentId: created.document.id, ownerUserId: null });
    assert.deepEqual(versions.map((version) => version.version), [1, 2, 3]);
    assert.deepEqual(versions.map((version) => version.status), ["indexed", "indexed", "indexed"]);

    const chunksPage = await repository.listChunks({ ownerUserId: null });
    // 三个 indexed 版本各自保留 chunks，旧版本 chunk 不被覆盖。
    assert.equal(chunksPage.chunks.length, 6);
    assert.equal(chunksPage.nextCursor, null);
  } finally {
    await context.cleanup();
  }
});

test("两个 pool 并发 saveIngestion 同一 externalId 只产生一个文档和版本", { skip: !integrationEnabled }, async () => {
  const { context, repository } = await createRagFixture();
  const secondPool = context.createPool();
  const secondRepository = createPostgresRagDocumentRepository(secondPool);
  try {
    const input = createIngestionInput();
    const results = await Promise.all([
      repository.saveIngestion(input),
      secondRepository.saveIngestion(input)
    ]);

    assert.ok(results.every((result) => result.version.status === "indexed"));
    assert.equal(new Set(results.map((result) => result.document.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.version.id)).size, 1);

    const documents = await repository.listDocuments({ ownerUserId: null });
    assert.equal(documents.documents.length, 1);
    const versions = await repository.listVersions({ documentId: documents.documents[0].documentId, ownerUserId: null });
    assert.equal(versions.length, 1);
    const chunks = await repository.listChunks({ ownerUserId: null });
    assert.equal(chunks.chunks.length, 2);
  } finally {
    await secondPool.end();
    await context.cleanup();
  }
});

test("scope 授权：private 仅 owner 可见，shared/demo 匿名可见", { skip: !integrationEnabled }, async () => {
  const { context, repository } = await createRagFixture();
  try {
    const userA = randomUUID();
    const userB = randomUUID();
    await insertUser(context.pool, userA);
    await insertUser(context.pool, userB);

    const privateDoc = await repository.saveIngestion(
      createIngestionInput({ ownerUserId: userA, scope: "private", externalId: "ext-private" })
    );
    await repository.saveIngestion(createIngestionInput({ scope: "shared", externalId: "ext-shared" }));
    await repository.saveIngestion(createIngestionInput({ scope: "demo", externalId: "ext-demo" }));

    const ownerPage = await repository.listDocuments({ ownerUserId: userA });
    const otherPage = await repository.listDocuments({ ownerUserId: userB });
    const anonymousPage = await repository.listDocuments({ ownerUserId: null });

    assert.equal(ownerPage.documents.length, 3);
    assert.equal(otherPage.documents.length, 2);
    assert.equal(anonymousPage.documents.length, 2);
    assert.ok(otherPage.documents.every((document) => document.scope !== "private"));
    assert.deepEqual(
      anonymousPage.documents.map((document) => document.scope).sort(),
      ["demo", "shared"]
    );

    const ownerChunks = await repository.listChunks({ ownerUserId: userA });
    const otherChunks = await repository.listChunks({ ownerUserId: userB });
    const anonymousChunks = await repository.listChunks({ ownerUserId: null });
    assert.equal(ownerChunks.chunks.length, 6);
    assert.equal(otherChunks.chunks.length, 4);
    assert.equal(anonymousChunks.chunks.length, 4);

    const privateVersionsForOther = await repository.listVersions({
      documentId: privateDoc.document.id,
      ownerUserId: userB
    });
    const privateVersionsForAnonymous = await repository.listVersions({
      documentId: privateDoc.document.id,
      ownerUserId: null
    });
    const privateVersionsForOwner = await repository.listVersions({
      documentId: privateDoc.document.id,
      ownerUserId: userA
    });
    assert.equal(privateVersionsForOther, undefined);
    assert.equal(privateVersionsForAnonymous, undefined);
    assert.equal(privateVersionsForOwner.length, 1);

    const filteredChunks = await repository.listChunks({
      ownerUserId: null,
      documentId: privateDoc.document.id
    });
    assert.equal(filteredChunks.chunks.length, 0);
  } finally {
    await context.cleanup();
  }
});

test("cursor 分页多页无重复无遗漏，重启后数据仍可读取", { skip: !integrationEnabled }, async () => {
  const { context, repository } = await createRagFixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      await repository.saveIngestion(
        createIngestionInput({
          externalId: `ext-page-${index}`,
          title: `分页文档 ${index}`,
          outcome: {
            status: "indexed",
            chunks: Array.from({ length: 3 }, (_, chunkIndex) => createChunk(chunkIndex, `文档 ${index} chunk ${chunkIndex}`))
          },
          now: `2026-01-0${index + 1}T00:00:00.000Z`
        })
      );
    }

    const seenDocuments = new Set();
    let documentCursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await repository.listDocuments({ ownerUserId: null, limit: 2, ...(documentCursor ? { cursor: documentCursor } : {}) });
      result.documents.forEach((document) => {
        assert.equal(seenDocuments.has(document.documentId), false, "文档分页出现重复");
        seenDocuments.add(document.documentId);
      });
      if (!result.nextCursor) break;
      documentCursor = result.nextCursor;
    }
    assert.equal(seenDocuments.size, 5);

    const seenChunks = new Set();
    let chunkCursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await repository.listChunks({ ownerUserId: null, limit: 4, ...(chunkCursor ? { cursor: chunkCursor } : {}) });
      result.chunks.forEach((chunk) => {
        assert.equal(seenChunks.has(chunk.chunkId), false, "chunk 分页出现重复");
        seenChunks.add(chunk.chunkId);
      });
      if (!result.nextCursor) break;
      chunkCursor = result.nextCursor;
    }
    assert.equal(seenChunks.size, 15);

    // 模拟进程重启：用同一 schema 的新连接池重新读取，数据仍在。
    const restartedPool = context.createPool();
    try {
      const restartedRepository = createPostgresRagDocumentRepository(restartedPool);
      const documentsAfterRestart = await restartedRepository.listDocuments({ ownerUserId: null });
      const chunksAfterRestart = await restartedRepository.listChunks({ ownerUserId: null, limit: 100 });
      assert.equal(documentsAfterRestart.documents.length, 5);
      assert.equal(chunksAfterRestart.chunks.length, 15);
      assert.equal(chunksAfterRestart.chunks[0].text.length > 0, true);
    } finally {
      await restartedPool.end();
    }
  } finally {
    await context.cleanup();
  }
});
