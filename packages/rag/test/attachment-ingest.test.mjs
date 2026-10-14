import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInMemoryAttachmentStore,
  DEFAULT_ATTACHMENT_INLINE_MAX_CHARS,
  ingestChatAttachment
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
const SMALL_TEXT = "公司 2024 年净利润 10 亿元，同比增长 25%。";

/**
 * 构造 ingest 所需的固定 fixture。
 */
function makeFixture() {
  return {
    embeddingClient: createDeterministicMockEmbeddingClient(),
    attachmentStore: createInMemoryAttachmentStore()
  };
}

test("ingestChatAttachment inlines small attachments without building a vector index", async () => {
  const { embeddingClient, attachmentStore } = makeFixture();

  const result = await ingestChatAttachment({
    embeddingClient,
    attachmentStore,
    conversationId: CONVERSATION_ID,
    documentId: "doc-small",
    source: "upload:doc-small",
    fileName: "note.md",
    contentType: "text/markdown",
    content: SMALL_TEXT
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "inline");
  assert.deepEqual(result.chunks, []);
  assert.equal(result.indexedChunkCount, 0);

  const inline = await attachmentStore.getInline(CONVERSATION_ID, "doc-small");
  assert.ok(inline);
  assert.ok(inline.text.includes("净利润"));
  assert.equal(inline.source, "upload:doc-small");
  assert.equal(inline.fileName, "note.md");

  // 内联路径不建向量索引：检索不到任何 chunk。
  const search = await attachmentStore.search(CONVERSATION_ID, [1, 0, 0], 5);
  assert.equal(search.ok, true);
  assert.deepEqual(search.matches, []);
});

test("ingestChatAttachment indexes large attachments when text exceeds inlineMaxChars", async () => {
  const { embeddingClient, attachmentStore } = makeFixture();

  const result = await ingestChatAttachment({
    embeddingClient,
    attachmentStore,
    conversationId: CONVERSATION_ID,
    documentId: "doc-large",
    source: "upload:doc-large",
    fileName: "note.md",
    contentType: "text/markdown",
    content: SMALL_TEXT,
    // 阈值压到极小值，强制走"大文件"索引路径。
    inlineMaxChars: 3
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "indexed");
  assert.ok(result.chunks.length >= 1);
  assert.ok(result.indexedChunkCount >= 1);

  // 索引路径不写内联槽，但向量检索可命中。
  assert.equal(await attachmentStore.getInline(CONVERSATION_ID, "doc-large"), null);
  const queryEmbedding = await embeddingClient.embedTexts(["净利润"]);
  assert.equal(queryEmbedding.ok, true);
  const search = await attachmentStore.search(CONVERSATION_ID, queryEmbedding.embeddings[0].vector, 5);
  assert.equal(search.ok, true);
  assert.ok(search.matches.length >= 1);
});

test("ingestChatAttachment uses the default inline threshold constant", () => {
  assert.equal(DEFAULT_ATTACHMENT_INLINE_MAX_CHARS, 200_000);
});

test("ingestChatAttachment preserves structured parsing errors", async () => {
  const { embeddingClient, attachmentStore } = makeFixture();

  const result = await ingestChatAttachment({
    embeddingClient,
    attachmentStore,
    conversationId: CONVERSATION_ID,
    documentId: "doc-bad",
    source: "upload:doc-bad",
    fileName: "report.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    content: "some text"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ingestion_failed");
  assert.equal(result.error.details.parsingCode, "unknown_file_type");
});
