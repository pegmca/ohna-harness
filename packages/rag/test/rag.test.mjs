import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkDocumentBlocks,
  chunkIngestedFilingDocument,
  chunkText,
  createRagAnswer,
  createRagPackageSummary,
  DEFAULT_CHUNKING_OPTIONS
} from "../dist/index.js";

test("rag package entry exposes its boundary summary", () => {
  const summary = createRagPackageSummary();

  assert.equal(summary.packageName, "@aiagent/rag");
  assert.equal(summary.boundary, "chunking_embedding_retrieval_citation_answer");
  assert.equal(summary.runtimeState, "chunking_ready");
});

test("default chunking options keep heading-aware chunks within a conservative size", () => {
  assert.equal(DEFAULT_CHUNKING_OPTIONS.strategy, "heading_aware");
  assert.equal(DEFAULT_CHUNKING_OPTIONS.maxChars, 1200);
  assert.equal(DEFAULT_CHUNKING_OPTIONS.overlapChars, 150);
});

test("fixed-size chunking splits long text with overlap and stable positions", () => {
  const result = chunkText(
    {
      documentId: "doc_fixed",
      source: "mock://fixed",
      text: "abcdefghijklmnopqrstuvwxyz"
    },
    {
      strategy: "fixed_size",
      maxChars: 10,
      overlapChars: 3
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.chunks.map((chunk) => chunk.text),
    ["abcdefghij", "hijklmnopq", "opqrstuvwx", "vwxyz"]
  );
  assert.deepEqual(
    result.chunks.map((chunk) => [chunk.charStart, chunk.charEnd]),
    [
      [0, 10],
      [7, 17],
      [14, 24],
      [21, 26]
    ]
  );
  assert.deepEqual(
    result.chunks.map((chunk) => chunk.chunkIndex),
    [0, 1, 2, 3]
  );
  assert.equal(result.chunks[2].chunkId, "doc_fixed_chunk_0002");
  assert.equal(result.chunks[2].id, result.chunks[2].chunkId);
});

test("short and empty text have explicit chunking behavior", () => {
  const shortResult = chunkText(
    {
      documentId: "doc_short",
      source: "mock://short",
      text: "短文本"
    },
    {
      strategy: "fixed_size",
      maxChars: 20,
      overlapChars: 5
    }
  );
  const emptyResult = chunkText(
    {
      documentId: "doc_empty",
      source: "mock://empty",
      text: " \n "
    },
    {
      strategy: "fixed_size",
      maxChars: 20,
      overlapChars: 5
    }
  );

  assert.equal(shortResult.ok, true);
  assert.equal(shortResult.chunks.length, 1);
  assert.equal(shortResult.chunks[0].text, "短文本");
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.chunks.length, 0);
});

test("invalid overlap returns a structured chunking error", () => {
  const result = chunkText(
    {
      documentId: "doc_invalid",
      source: "mock://invalid",
      text: "abcdef"
    },
    {
      strategy: "fixed_size",
      maxChars: 5,
      overlapChars: 5
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_chunking_options");
  assert.equal(result.error.details.maxChars, 5);
  assert.equal(result.error.details.overlapChars, 5);
});

test("heading-aware chunking preserves block heading, line range and source metadata", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_heading",
      source: "local://annual-report.md",
      blocks: [
        {
          id: "doc_heading_block_0001",
          text: "管理层讨论与分析",
          heading: "管理层讨论与分析",
          lineStart: 1,
          lineEnd: 1,
          metadata: {
            blockRole: "heading"
          }
        },
        {
          id: "doc_heading_block_0002",
          text: "资产质量保持稳健，净利润同比增长。",
          heading: "管理层讨论与分析",
          lineStart: 3,
          lineEnd: 4,
          pageNumber: 12,
          metadata: {
            sectionKind: "management"
          }
        }
      ]
    },
    {
      strategy: "heading_aware",
      maxChars: 100,
      overlapChars: 10
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[1].documentId, "doc_heading");
  assert.equal(result.chunks[1].source, "local://annual-report.md");
  assert.equal(result.chunks[1].heading, "管理层讨论与分析");
  assert.equal(result.chunks[1].page, 12);
  assert.equal(result.chunks[1].pageNumber, 12);
  assert.equal(result.chunks[1].metadata.blockId, "doc_heading_block_0002");
  assert.equal(result.chunks[1].metadata.lineStart, 3);
  assert.equal(result.chunks[1].metadata.lineEnd, 4);
  assert.equal(result.chunks[1].metadata.sectionKind, "management");
});

test("oversized heading-aware block falls back to fixed-size chunks", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_long_section",
      source: "mock://long-section",
      blocks: [
        {
          id: "doc_long_section_block_0001",
          text: "0123456789ABCDEFGHIJ",
          heading: "风险提示",
          lineStart: 8,
          lineEnd: 9,
          metadata: {}
        }
      ]
    },
    {
      strategy: "heading_aware",
      maxChars: 8,
      overlapChars: 2
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.chunks.map((chunk) => chunk.text),
    ["01234567", "6789ABCD", "CDEFGHIJ"]
  );
  assert.ok(result.chunks.every((chunk) => chunk.text.length <= 8));
  assert.ok(result.chunks.every((chunk) => chunk.heading === "风险提示"));
});

test("ingested filing documents can be chunked directly", () => {
  const result = chunkIngestedFilingDocument(
    {
      documentId: "filing_doc",
      source: "local://filing.md",
      fileName: "filing.md",
      title: "公告摘要",
      fileType: "markdown",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        ticker: "000001.SZ"
      },
      blocks: [
        {
          id: "filing_doc_block_0001",
          text: "营收增长，现金流改善。",
          heading: "经营情况",
          lineStart: 2,
          lineEnd: 2,
          metadata: {}
        }
      ]
    },
    {
      strategy: "heading_aware",
      maxChars: 50,
      overlapChars: 5
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks[0].chunkId, "filing_doc_chunk_0000");
  assert.equal(result.chunks[0].metadata.blockId, "filing_doc_block_0001");
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
