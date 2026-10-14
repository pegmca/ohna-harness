import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAttachmentRetriever,
  createGroundingTransformContext,
  createInMemoryAttachmentStore,
  ingestChatAttachment
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

const CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_USER_ID = "00000000-0000-0000-0000-000000000001";

/**
 * 构造一个已注入会话附件的 grounding fixture：附件检索器 + 会话 id。
 */
async function createFixture() {
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
    content: "公司 2024 年净利润 10 亿元，同比增长 25%。"
  });
  assert.equal(ingest.ok, true);

  return {
    attachmentRetriever: createAttachmentRetriever({
      embeddingClient,
      attachmentStore,
      conversationId: CONVERSATION_ID
    })
  };
}

/**
 * 创建一条简单的 user AgentMessage。
 */
function userMessage(text, timestamp) {
  return { role: "user", content: text, timestamp };
}

test("grounding hook injects <untrusted_context> before the last user message", async () => {
  const fixture = await createFixture();
  const retrievalEvents = [];
  const grounding = createGroundingTransformContext({
    attachmentRetriever: fixture.attachmentRetriever,
    conversationId: CONVERSATION_ID,
    attachmentDocumentIds: ["doc-1"],
    ownerUserId: OWNER_USER_ID,
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
  assert.equal(retrievalEvents[0].mode, "vector");

  const citations = grounding.getCitationsForTurn(1000);
  assert.equal(citations.length, 1);
  assert.ok(citations[0].quote.includes("净利润"));
});

test("grounding hook deduplicates citations across turns with the same user message", async () => {
  const fixture = await createFixture();
  const grounding = createGroundingTransformContext({
    attachmentRetriever: fixture.attachmentRetriever,
    conversationId: CONVERSATION_ID,
    attachmentDocumentIds: ["doc-1"],
    ownerUserId: OWNER_USER_ID
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
  const fixture = await createFixture();
  const grounding = createGroundingTransformContext({
    attachmentRetriever: fixture.attachmentRetriever,
    conversationId: CONVERSATION_ID,
    attachmentDocumentIds: [],
    ownerUserId: OWNER_USER_ID
  });

  const messages = [userMessage(" hello ", 3000)];
  const transformed = await grounding(messages);

  assert.deepEqual(transformed, messages);
  assert.equal(grounding.getCitationsForTurn(3000).length, 0);
});
