import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDataSourceRuntime,
  createGroundingTransformContext,
  createInMemoryRagDocumentRepository,
  createInMemoryVectorStore
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

/**
 * 构造一个带私有文档的 runtime，供 grounding hook 测试复用。
 */
function createFixtureRuntime() {
  return createDataSourceRuntime({
    repository: createInMemoryRagDocumentRepository(),
    embeddingClient: createDeterministicMockEmbeddingClient(),
    vectorStoreFactory: () => createInMemoryVectorStore()
  });
}

/**
 * 创建一条简单的 user AgentMessage。
 */
function userMessage(text, timestamp) {
  return { role: "user", content: text, timestamp };
}

test("grounding hook injects <untrusted_context> before the last user message", async () => {
  const runtime = createFixtureRuntime();
  const ownerUserId = "00000000-0000-0000-0000-000000000001";
  const ingest = await runtime.ingest(
    {
      source: "upload:attach-1",
      fileName: "note.md",
      contentType: "text/markdown",
      content: "公司 2024 年净利润 10 亿元，同比增长 25%。"
    },
    { ownerUserId }
  );
  assert.equal(ingest.ok, true);

  const documentId = ingest.data.document.documentId;
  const retrievalEvents = [];
  const grounding = createGroundingTransformContext({
    runtime,
    attachmentDocumentIds: [documentId],
    ownerUserId,
    recordRetrieval: (event) => {
      retrievalEvents.push(event);
    }
  });

  const messages = [userMessage("分析净利润", 1000)];
  const transformed = await grounding(messages);

  assert.equal(transformed.length, 2);
  assert.equal(transformed[0].role, "user");
  assert.equal(typeof transformed[0].content, "string");
  assert.ok(String(transformed[0].content).includes("10 亿元"));
  assert.equal(transformed[1].role, "user");
  assert.equal(transformed[1].content, "分析净利润");

  assert.equal(retrievalEvents.length, 1);
  assert.equal(retrievalEvents[0].type, "retrieval");
  assert.equal(retrievalEvents[0].ok, true);

  const citations = grounding.getCitationsForTurn(1000);
  assert.equal(citations.length, 1);
  assert.ok(citations[0].quote.includes("净利润"));
});

test("grounding hook deduplicates citations across turns with the same user message", async () => {
  const runtime = createFixtureRuntime();
  const ownerUserId = "00000000-0000-0000-0000-000000000002";
  const ingest = await runtime.ingest(
    {
      source: "upload:attach-2",
      fileName: "note.md",
      contentType: "text/markdown",
      content: "公司 2024 年净利润 10 亿元，同比增长 25%。"
    },
    { ownerUserId }
  );
  assert.equal(ingest.ok, true);

  const documentId = ingest.data.document.documentId;
  const grounding = createGroundingTransformContext({
    runtime,
    attachmentDocumentIds: [documentId],
    ownerUserId
  });

  // 第一轮：注入 1 条 citation。
  const first = await grounding([userMessage("分析净利润", 2000)]);
  assert.equal(first.length, 2);
  assert.equal(grounding.getCitationsForTurn(2000).length, 1);

  // 第二轮：同一条用户消息时间戳，已被注入的 chunk 不再重复。
  const second = await grounding([
    userMessage("分析净利润", 2000),
    { role: "assistant", content: [{ type: "text", text: "已调用工具" }], timestamp: 2001 },
    { role: "toolResult", toolCallId: "t1", toolName: "calc", content: [{ type: "text", text: "result" }], isError: false, timestamp: 2002 }
  ]);
  assert.equal(second.length, 3);
  assert.equal(grounding.getCitationsForTurn(2000).length, 1);
});

test("grounding hook returns empty citations when no attachment is referenced", async () => {
  const runtime = createFixtureRuntime();
  const grounding = createGroundingTransformContext({
    runtime,
    attachmentDocumentIds: [],
    ownerUserId: "00000000-0000-0000-0000-000000000003"
  });

  const messages = [userMessage(" hello ", 3000)];
  const transformed = await grounding(messages);

  assert.deepEqual(transformed, messages);
  assert.equal(grounding.getCitationsForTurn(3000).length, 0);
});
