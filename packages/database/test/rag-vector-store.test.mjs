import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPostgresRagDocumentRepository,
  createPostgresVectorStore,
  POSTGRES_RAG_VECTOR_DIMENSIONS,
  POSTGRES_RAG_VECTOR_MODEL
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../../rag/dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

/** @param {string} value 文本。 @returns {string} SHA-256 hex。 */
function checksum(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @param {number} chunkIndex 序号。 @param {string} text 正文。 @returns {object} chunk 输入。 */
function createChunk(chunkIndex, text) {
  return {
    chunkIndex,
    text,
    heading: "检索章节",
    metadata: { charStart: 0, charEnd: text.length, startOffset: 0, endOffset: text.length },
    contentChecksum: checksum(text)
  };
}

/**
 * @param {object} overrides ingestion 覆盖字段。
 * @returns {object} saveIngestion 输入。
 */
function createIngestion(overrides = {}) {
  const text = overrides.text ?? "净利润同比增长，资产质量保持稳定。";
  return {
    ownerUserId: null,
    scope: "shared",
    sourceType: "mock_text",
    externalId: `vector-${randomUUID()}`,
    title: "向量检索测试",
    sourceUri: "demo/vector-source",
    contentType: "text/plain",
    contentChecksum: checksum(text),
    content: text,
    parserVersion: "test-parser-v1",
    chunkerVersion: "test-chunker-v1",
    outcome: { status: "indexed", chunks: [createChunk(0, text)] },
    now: "2026-07-25T00:00:00.000Z",
    ...overrides
  };
}

/** @param {object} pool 测试 pool。 @param {string} userId 用户。 @returns {Promise<void>} 完成。 */
async function insertUser(pool, userId) {
  await pool.query("insert into users(id, created_at, updated_at, last_seen_at) values ($1, now(), now(), now())", [userId]);
}

/**
 * @param {object} record 持久化 chunk。
 * @param {readonly number[]} vector embedding。
 * @returns {object} EmbeddedChunk。
 */
function embeddedChunk(record, vector) {
  return {
    chunkId: record.chunkId,
    id: record.chunkId,
    documentId: record.documentId,
    source: record.source,
    chunkIndex: record.chunkIndex,
    text: record.text,
    charStart: 0,
    charEnd: record.text.length,
    startOffset: 0,
    endOffset: record.text.length,
    heading: record.heading,
    metadata: { ...record.metadata },
    embedding: vector,
    embeddingModel: POSTGRES_RAG_VECTOR_MODEL
  };
}

/** @returns {Promise<object>} 已迁移测试 fixture。 */
async function createFixture() {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  await runMigrations(context.pool, join(packageDir, "migrations"));
  return {
    context,
    repository: createPostgresRagDocumentRepository(context.pool),
    embeddingClient: createDeterministicMockEmbeddingClient({
      model: POSTGRES_RAG_VECTOR_MODEL,
      dimensions: POSTGRES_RAG_VECTOR_DIMENSIONS
    })
  };
}

test("pgvector upsert 幂等，checksum 变化会刷新旧向量", { skip: !integrationEnabled }, async () => {
  const { context, repository, embeddingClient } = await createFixture();
  try {
    const saved = await repository.saveIngestion(createIngestion());
    const firstEmbedding = await embeddingClient.embedTexts([saved.chunks[0].text]);
    assert.equal(firstEmbedding.ok, true);
    const store = createPostgresVectorStore(context.pool, { ownerUserId: null });
    const firstChunk = embeddedChunk(saved.chunks[0], firstEmbedding.embeddings[0].vector);

    const first = await store.upsertChunks([firstChunk]);
    const second = await store.upsertChunks([firstChunk]);
    assert.deepEqual(
      { ok: first.ok, replacedCount: first.replacedCount, totalCount: first.totalCount },
      { ok: true, replacedCount: 0, totalCount: 1 }
    );
    assert.deepEqual(
      { ok: second.ok, replacedCount: second.replacedCount, totalCount: second.totalCount },
      { ok: true, replacedCount: 0, totalCount: 1 }
    );

    const changedText = "净利润转为下降，旧向量必须刷新。";
    await context.pool.query("update chunks set chunk_text = $2, content_checksum = $3 where document_version_id = $1 and chunk_index = 0", [
      saved.version.id,
      changedText,
      checksum(changedText)
    ]);
    const changedEmbedding = await embeddingClient.embedTexts([changedText]);
    assert.equal(changedEmbedding.ok, true);
    const refreshed = await store.upsertChunks([
      { ...firstChunk, text: changedText, embedding: changedEmbedding.embeddings[0].vector }
    ]);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.replacedCount, 1);
    const search = await store.search(changedEmbedding.embeddings[0].vector, { topK: 1 });
    assert.equal(search.ok, true);
    assert.equal(search.matches[0].chunk.text, changedText);
  } finally {
    await context.cleanup();
  }
});

test("pgvector search 在 cosine 排序前执行 owner/scope 与有效状态过滤，重启后稳定", { skip: !integrationEnabled }, async () => {
  const { context, repository, embeddingClient } = await createFixture();
  try {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    await insertUser(context.pool, ownerA);
    await insertUser(context.pool, ownerB);
    const privateA = await repository.saveIngestion(createIngestion({
      ownerUserId: ownerA,
      scope: "private",
      externalId: "private-a",
      sourceUri: "demo/private-a",
      text: "A 用户绝密向量内容"
    }));
    const privateB = await repository.saveIngestion(createIngestion({
      ownerUserId: ownerB,
      scope: "private",
      externalId: "private-b",
      sourceUri: "demo/private-b",
      text: "B 用户绝密向量内容"
    }));
    const shared = await repository.saveIngestion(createIngestion({
      externalId: "shared",
      sourceUri: "demo/shared",
      text: "全员共享向量内容"
    }));
    const all = [...privateA.chunks, ...privateB.chunks, ...shared.chunks];
    const embeddings = await embeddingClient.embedTexts(all.map((chunk) => chunk.text));
    assert.equal(embeddings.ok, true);
    // 分别以各自 owner 写入，模拟 ingestion composition root 的身份绑定。
    await createPostgresVectorStore(context.pool, { ownerUserId: ownerA }).upsertChunks([
      embeddedChunk(privateA.chunks[0], embeddings.embeddings[0].vector),
      embeddedChunk(shared.chunks[0], embeddings.embeddings[2].vector)
    ]);
    await createPostgresVectorStore(context.pool, { ownerUserId: ownerB }).upsertChunks([
      embeddedChunk(privateB.chunks[0], embeddings.embeddings[1].vector)
    ]);

    const query = embeddings.embeddings[1].vector;
    const ownerStore = createPostgresVectorStore(context.pool, { ownerUserId: ownerA });
    const ownerResult = await ownerStore.search(query, { topK: 10 });
    assert.equal(ownerResult.ok, true);
    assert.deepEqual(
      ownerResult.matches.map((match) => match.chunk.text).sort(),
      ["A 用户绝密向量内容", "全员共享向量内容"].sort()
    );
    assert.ok(ownerResult.matches.every((match) => !match.chunk.text.includes("B 用户")));

    const restartedPool = context.createPool();
    try {
      const afterRestart = await createPostgresVectorStore(restartedPool, { ownerUserId: ownerA }).search(query, { topK: 10 });
      assert.equal(afterRestart.ok, true);
      assert.deepEqual(
        afterRestart.matches.map((match) => [match.chunk.chunkId, match.score]),
        ownerResult.matches.map((match) => [match.chunk.chunkId, match.score])
      );
    } finally {
      await restartedPool.end();
    }
  } finally {
    await context.cleanup();
  }
});

test("pgvector model、dimensions 与 checksum 不一致返回结构化错误", { skip: !integrationEnabled }, async () => {
  const { context, repository, embeddingClient } = await createFixture();
  try {
    const saved = await repository.saveIngestion(createIngestion());
    const embedding = await embeddingClient.embedTexts([saved.chunks[0].text]);
    assert.equal(embedding.ok, true);
    const chunk = embeddedChunk(saved.chunks[0], embedding.embeddings[0].vector);
    const store = createPostgresVectorStore(context.pool, { ownerUserId: null });
    const wrongModel = await store.upsertChunks([{ ...chunk, embeddingModel: "other-model" }]);
    const wrongDimensions = await store.upsertChunks([{ ...chunk, embedding: [1, 0] }]);
    const wrongChecksum = await store.upsertChunks([{ ...chunk, text: `${chunk.text}已篡改` }]);
    assert.equal(wrongModel.ok, false);
    assert.equal(wrongModel.error.code, "embedding_model_mismatch");
    assert.equal(wrongDimensions.ok, false);
    assert.equal(wrongDimensions.error.code, "embedding_dimension_mismatch");
    assert.equal(wrongChecksum.ok, false);
    assert.equal(wrongChecksum.error.code, "embedding_checksum_mismatch");
  } finally {
    await context.cleanup();
  }
});

test("pgvector 数据库失败不会泄漏 SQL", { skip: !integrationEnabled }, async () => {
  const { context } = await createFixture();
  try {
    const closedPool = context.createPool();
    const store = createPostgresVectorStore(closedPool, { ownerUserId: null });
    await closedPool.end();
    const result = await store.search(new Array(32).fill(0));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "retrieval_failed");
    assert.doesNotMatch(result.error.message, /select|chunk_embeddings|connection refused|ECONN|password authentication/i);
  } finally {
    await context.cleanup();
  }
});
