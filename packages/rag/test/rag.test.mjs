import assert from "node:assert/strict";
import { test } from "node:test";
import { createRagAnswer, createRagPackageSummary } from "../dist/index.js";

test("rag package entry exposes its boundary summary", () => {
  const summary = createRagPackageSummary();

  assert.equal(summary.packageName, "@aiagent/rag");
  assert.equal(summary.boundary, "chunking_embedding_retrieval_citation_answer");
  assert.equal(summary.runtimeState, "types_and_mock_only");
});

test("rag answer can express citations and retrieval results", () => {
  const answer = createRagAnswer({
    answer: "公司净利润同比增长，依据年报管理层讨论章节。",
    citations: [
      {
        chunkId: "chunk_001",
        documentId: "doc_001",
        quote: "净利润同比增长",
        pageNumber: 12,
        confidence: 0.92
      }
    ],
    retrievalResults: [
      {
        chunkId: "chunk_001",
        documentId: "doc_001",
        score: 0.88,
        text: "净利润同比增长，资产质量保持稳定。",
        citation: {
          chunkId: "chunk_001",
          documentId: "doc_001",
          quote: "净利润同比增长",
          pageNumber: 12,
          confidence: 0.92
        }
      }
    ]
  });

  assert.equal(answer.citations.length, 1);
  assert.equal(answer.retrievalResults[0].score, 0.88);
  assert.match(answer.answer, /净利润/);
});
