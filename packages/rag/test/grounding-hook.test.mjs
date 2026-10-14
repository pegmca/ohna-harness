import assert from "node:assert/strict";
import { test } from "node:test";
import { createGroundingTransformContext } from "../dist/index.js";

const CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";

/**
 * 构造一个内联附件 fixture（小附件原文直接注入，不经检索）。
 */
function makeInlineAttachment(overrides = {}) {
  return {
    documentId: "doc-inline",
    text: "公司 2024 年净利润 10 亿元，同比增长 25%。",
    source: "upload:doc-inline",
    fileName: "note.md",
    ...overrides
  };
}

/**
 * 构造一个最小 RetrievedChunk，供 stub retriever 返回。
 */
function makeRetrievedChunk({ chunkId, text, source, sourceKind, rank = 1 }) {
  return {
    chunk: {
      chunkId,
      id: chunkId,
      documentId: chunkId.replace(/_chunk_.*$/, ""),
      source,
      chunkIndex: 0,
      text,
      charStart: 0,
      charEnd: text.length,
      startOffset: 0,
      endOffset: text.length,
      metadata: {},
      embedding: [],
      embeddingModel: "test"
    },
    rank,
    score: 0.9,
    scoreBreakdown: {
      vectorScore: 0.9,
      keywordScore: 0,
      hybridScore: 0.9,
      finalScore: 0.9,
      vectorWeight: 1,
      keywordWeight: 0,
      matchedTerms: [],
      queryTermCoverage: 0,
      headingMatch: false
    },
    ...(sourceKind ? { sourceKind } : {})
  };
}

/**
 * 构造一个 stub Retriever，按给定结果或失败返回，并记录调用参数。
 */
function makeStubRetriever({ results = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    retrieve: async (query, options = {}) => {
      calls.push({ query, options });
      if (fail) {
        return {
          ok: false,
          error: { code: "retrieval_failed", message: "leg down" },
          trace: {
            queryPreview: query,
            mode: "hybrid",
            topK: options.topK ?? 5,
            candidateLimit: 5,
            durationMs: 1,
            chunkIds: [],
            scoreSummary: []
          }
        };
      }
      return {
        ok: true,
        results,
        trace: {
          queryPreview: query,
          mode: "hybrid",
          topK: options.topK ?? 5,
          candidateLimit: 5,
          durationMs: 1,
          chunkIds: results.map((item) => item.chunk.chunkId),
          scoreSummary: []
        }
      };
    }
  };
}

/**
 * 创建一条简单的 user AgentMessage。
 */
function userMessage(text, timestamp) {
  return { role: "user", content: text, timestamp };
}

test("grounding hook injects inline attachments without a retriever", async () => {
  const grounding = createGroundingTransformContext({
    inlineAttachments: [makeInlineAttachment()],
    conversationId: CONVERSATION_ID
  });

  const messages = [userMessage("分析净利润", 1000)];
  const transformed = await grounding(messages);

  assert.equal(transformed.length, 2);
  assert.equal(transformed[0].role, "user");
  assert.ok(String(transformed[0].content).includes("10 亿元"));
  assert.ok(String(transformed[0].content).includes("附件"));
  assert.equal(transformed[1].content, "分析净利润");

  const citations = grounding.getCitationsForTurn(1000);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].chunkId, "doc-inline");
  assert.equal(citations[0].sourceKind, "attachment");
  assert.equal(citations[0].source, "note.md");
});

test("grounding hook merges inline attachments and retriever results with source labels", async () => {
  const retriever = makeStubRetriever({
    results: [
      makeRetrievedChunk({
        chunkId: "internal_chunk_0000",
        text: "内部知识库：2024 年净利润 8 亿元。",
        source: "annual-report",
        sourceKind: "internal"
      })
    ]
  });
  const events = [];
  const grounding = createGroundingTransformContext({
    retriever,
    inlineAttachments: [makeInlineAttachment({ text: "附件原文：毛利率 30%。" })],
    conversationId: CONVERSATION_ID,
    recordRetrieval: (event) => {
      events.push(event);
    }
  });

  const transformed = await grounding([userMessage("对比毛利率和净利润", 1500)]);

  assert.equal(transformed.length, 2);
  const content = String(transformed[0].content);
  assert.ok(content.includes("毛利率 30%"));
  assert.ok(content.includes("8 亿元"));
  assert.ok(content.includes("附件"));
  assert.ok(content.includes("内部知识库"));

  const citations = grounding.getCitationsForTurn(1500);
  assert.equal(citations.length, 2);
  // 内联合成候选在前，检索结果在后。
  assert.equal(citations[0].sourceKind, "attachment");
  assert.equal(citations[1].sourceKind, "internal");

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "retrieval");
  assert.equal(events[0].ok, true);
  // 检索器收到 topK（默认 5），并带 rerank 关闭的中间态。
  assert.equal(retriever.calls.length, 1);
  assert.equal(retriever.calls[0].options.topK, 5);
});

test("grounding hook deduplicates injected chunks across turns with the same user message", async () => {
  const grounding = createGroundingTransformContext({
    inlineAttachments: [makeInlineAttachment()],
    conversationId: CONVERSATION_ID
  });

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

test("grounding hook injects nothing when there is neither retriever nor inline attachment", async () => {
  const grounding = createGroundingTransformContext({ conversationId: CONVERSATION_ID });

  const messages = [userMessage(" hello ", 3000)];
  const transformed = await grounding(messages);

  assert.deepEqual(transformed, messages);
  assert.equal(grounding.getCitationsForTurn(3000).length, 0);
});

test("grounding hook still injects inline attachments and records a failed trace when the retrieval leg fails", async () => {
  const retriever = makeStubRetriever({ fail: true });
  const events = [];
  const grounding = createGroundingTransformContext({
    retriever,
    inlineAttachments: [makeInlineAttachment({ text: "附件原文：毛利率 30%。" })],
    conversationId: CONVERSATION_ID,
    recordRetrieval: (event) => {
      events.push(event);
    }
  });

  const transformed = await grounding([userMessage("分析毛利率", 4000)]);

  assert.equal(transformed.length, 2);
  assert.ok(String(transformed[0].content).includes("毛利率 30%"));
  assert.equal(grounding.getCitationsForTurn(4000).length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
});
