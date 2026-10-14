import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAttachmentRetriever,
  createInMemoryAttachmentStore,
  ingestChatAttachment
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";

/**
 * 为用例准备一个带会话附件的检索器 fixture。
 */
async function createSeededRetriever(options = {}) {
  const embeddingClient = createDeterministicMockEmbeddingClient();
  const attachmentStore = createInMemoryAttachmentStore();

  const ingest = await ingestChatAttachment({
    embeddingClient,
    attachmentStore,
    conversationId: CONVERSATION_ID,
    documentId: "doc-1",
    source: "upload:doc-1",
    fileName: "note.md",
    contentType: "text/markdown",
    content: "公司 2024 年净利润 10 亿元，同比增长 25%。",
    // 附件检索器只消费向量索引；阈值压到 0 强制走 indexed 路径（内联路径不建索引）。
    inlineMaxChars: 0
  });
  assert.equal(ingest.ok, true);
  assert.equal(ingest.mode, "indexed");

  return {
    embeddingClient,
    attachmentStore,
    retriever: createAttachmentRetriever({
      embeddingClient,
      attachmentStore,
      conversationId: CONVERSATION_ID,
      ...options
    })
  };
}

test("attachment retriever returns vector-only results and a vector trace", async () => {
  const { retriever } = await createSeededRetriever();
  const result = await retriever.retrieve("分析净利润", { topK: 3 });

  assert.equal(result.ok, true);
  assert.ok(result.results.length > 0);

  const first = result.results[0];
  assert.equal(first.scoreBreakdown.vectorWeight, 1);
  assert.equal(first.scoreBreakdown.keywordWeight, 0);
  assert.deepEqual(first.scoreBreakdown.matchedTerms, []);
  assert.equal(first.scoreBreakdown.queryTermCoverage, 0);
  assert.equal(first.scoreBreakdown.headingMatch, false);
  assert.equal(first.scoreBreakdown.vectorScore, first.score);
  assert.equal(first.scoreBreakdown.finalScore, first.score);

  assert.equal(result.trace.mode, "vector");
  assert.equal(result.trace.topK, 3);
  assert.equal(result.trace.candidateLimit, 3);
  assert.deepEqual(
    result.trace.chunkIds,
    result.results.map((item) => item.chunk.chunkId)
  );
  assert.equal(result.trace.scoreSummary[0].vectorScore, first.score);
});

test("attachment retriever resolves topK from options, then constructor, then default", async () => {
  const { retriever } = await createSeededRetriever();

  const defaulted = await retriever.retrieve("分析净利润");
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.trace.topK, 5);

  const configured = await createSeededRetriever({ topK: 2 });
  const fromConstructor = await configured.retriever.retrieve("分析净利润");
  assert.equal(fromConstructor.ok, true);
  assert.equal(fromConstructor.trace.topK, 2);

  const fromOptions = await retriever.retrieve("分析净利润", { topK: 1 });
  assert.equal(fromOptions.ok, true);
  assert.equal(fromOptions.trace.topK, 1);
  assert.ok(fromOptions.results.length <= 1);
});

test("attachment retriever returns empty results for a conversation without attachments", async () => {
  const retriever = createAttachmentRetriever({
    embeddingClient: createDeterministicMockEmbeddingClient(),
    attachmentStore: createInMemoryAttachmentStore(),
    conversationId: CONVERSATION_ID
  });

  const result = await retriever.retrieve("分析净利润", { topK: 5 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.trace.chunkIds, []);
});

test("attachment retriever maps embedding failures to a structured error with a trace", async () => {
  const failingEmbeddingClient = {
    embedTexts: async () => ({
      ok: false,
      error: { code: "embedding_failed", message: "provider 不可用" }
    })
  };
  const retriever = createAttachmentRetriever({
    embeddingClient: failingEmbeddingClient,
    attachmentStore: createInMemoryAttachmentStore(),
    conversationId: CONVERSATION_ID
  });

  const result = await retriever.retrieve("分析净利润", { topK: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "embedding_failed");
  assert.equal(result.trace.mode, "vector");
  assert.deepEqual(result.trace.chunkIds, []);
});

test("attachment retriever maps store search failures to a structured error with a trace", async () => {
  const failingStore = {
    upsert: async () => ({ ok: true, upsertedCount: 0, replacedCount: 0, totalCount: 0, dimensions: 0 }),
    search: async () => ({
      ok: false,
      error: { code: "attachment_store_failed", message: "附件索引不可用" }
    }),
    touch: async () => {},
    drop: async () => {}
  };
  const retriever = createAttachmentRetriever({
    embeddingClient: createDeterministicMockEmbeddingClient(),
    attachmentStore: failingStore,
    conversationId: CONVERSATION_ID
  });

  const result = await retriever.retrieve("分析净利润", { topK: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "attachment_store_failed");
  assert.equal(result.trace.mode, "vector");
});
