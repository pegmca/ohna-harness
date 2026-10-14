import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInMemoryAttachmentStore,
  MAX_VECTOR_SEARCH_TOP_K
} from "../dist/index.js";

/**
 * 构造一个最小可用的 EmbeddedChunk，供附件存储单测复用。
 */
function makeChunk({ chunkId, documentId, embedding, chunkIndex = 0, text = "text" }) {
  return {
    chunkId,
    id: chunkId,
    documentId,
    source: `upload:${documentId}`,
    chunkIndex,
    text,
    charStart: 0,
    charEnd: text.length,
    startOffset: 0,
    endOffset: text.length,
    metadata: {},
    embedding,
    embeddingModel: "test-embedding"
  };
}

test("attachment store upserts and searches within a conversation by cosine similarity", async () => {
  const store = createInMemoryAttachmentStore();
  const conversationId = "conv-a";

  const upsert = await store.upsert(conversationId, "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0, 0], chunkIndex: 0 }),
    makeChunk({ chunkId: "c2", documentId: "doc-1", embedding: [0, 1, 0], chunkIndex: 1 })
  ]);

  assert.equal(upsert.ok, true);
  assert.equal(upsert.upsertedCount, 2);
  assert.equal(upsert.replacedCount, 0);
  assert.equal(upsert.totalCount, 2);
  assert.equal(upsert.dimensions, 3);

  const search = await store.search(conversationId, [1, 0, 0], 5);

  assert.equal(search.ok, true);
  assert.equal(search.matches.length, 2);
  assert.equal(search.matches[0].chunk.chunkId, "c1");
  assert.equal(search.matches[0].rank, 1);
  assert.equal(search.matches[0].score, 1);
  assert.equal(search.matches[1].chunk.chunkId, "c2");
  assert.equal(search.matches[1].rank, 2);
});

test("attachment store replaces chunks with the same chunkId and caps topK", async () => {
  const store = createInMemoryAttachmentStore();
  const conversationId = "conv-b";

  await store.upsert(conversationId, "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0] })
  ]);
  const replaced = await store.upsert(conversationId, "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [0, 1] })
  ]);

  assert.equal(replaced.ok, true);
  assert.equal(replaced.replacedCount, 1);
  assert.equal(replaced.totalCount, 1);

  const many = Array.from({ length: 60 }, (_value, index) =>
    makeChunk({
      chunkId: `c${index}`,
      documentId: "doc-1",
      embedding: [index + 1, 1],
      chunkIndex: index
    })
  );
  await store.upsert(conversationId, "doc-2", many);

  const capped = await store.search(conversationId, [1, 0], 100);

  assert.equal(capped.ok, true);
  assert.equal(capped.matches.length, MAX_VECTOR_SEARCH_TOP_K);
});

test("attachment store isolates conversations and returns empty for unknown conversations", async () => {
  const store = createInMemoryAttachmentStore();

  await store.upsert("conv-a", "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0, 0] })
  ]);

  const crossConversation = await store.search("conv-b", [1, 0, 0], 5);
  assert.equal(crossConversation.ok, true);
  assert.deepEqual(crossConversation.matches, []);
});

test("attachment store returns structured errors for dimension mismatch", async () => {
  const store = createInMemoryAttachmentStore();
  const conversationId = "conv-dim";

  await store.upsert(conversationId, "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0, 0] })
  ]);

  const search = await store.search(conversationId, [1, 0], 5);

  assert.equal(search.ok, false);
  assert.equal(search.error.code, "vector_store_dimension_mismatch");
});

test("attachment store rejects inconsistent upsert dimensions", async () => {
  const store = createInMemoryAttachmentStore();

  const upsert = await store.upsert("conv-dim", "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0, 0] }),
    makeChunk({ chunkId: "c2", documentId: "doc-1", embedding: [1, 0] })
  ]);

  assert.equal(upsert.ok, false);
  assert.equal(upsert.error.code, "embedding_dimension_mismatch");
});

test("attachment store rejects blank scope for upsert and search", async () => {
  const store = createInMemoryAttachmentStore();

  const blankConversation = await store.upsert("", "doc-1", []);
  assert.equal(blankConversation.ok, false);
  assert.equal(blankConversation.error.code, "invalid_attachment_scope");

  const blankDocument = await store.upsert("conv-a", "   ", []);
  assert.equal(blankDocument.ok, false);
  assert.equal(blankDocument.error.code, "invalid_attachment_scope");

  const blankSearch = await store.search("", [1, 0, 0], 5);
  assert.equal(blankSearch.ok, false);
  assert.equal(blankSearch.error.code, "invalid_attachment_scope");
});

test("attachment store drop reclaims a conversation bucket and touch is a no-op", async () => {
  const store = createInMemoryAttachmentStore();
  const conversationId = "conv-drop";

  await store.upsert(conversationId, "doc-1", [
    makeChunk({ chunkId: "c1", documentId: "doc-1", embedding: [1, 0, 0] })
  ]);

  await store.touch(conversationId);
  await store.drop(conversationId);

  const search = await store.search(conversationId, [1, 0, 0], 5);
  assert.equal(search.ok, true);
  assert.deepEqual(search.matches, []);
});
