import assert from "node:assert/strict";
import { test } from "node:test";
import { createMultiSourceRetriever } from "../dist/index.js";

/**
 * 构造一个最小 RetrievedChunk，供 stub retriever 返回。
 */
function makeRetrievedChunk({ chunkId, text, source, sourceKind, rank = 1, score = 0.9 }) {
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
    score,
    scoreBreakdown: {
      vectorScore: score,
      keywordScore: 0,
      hybridScore: score,
      finalScore: score,
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
 * 构造一个 stub Retriever：返回给定结果或失败，并记录调用参数。
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
          trace: emptyTrace(query, options)
        };
      }
      return { ok: true, results, trace: emptyTrace(query, options) };
    }
  };
}

/**
 * 构造 stub retriever 的 trace 占位（编排器不读取 leg 的 trace）。
 */
function emptyTrace(query, options = {}) {
  return {
    queryPreview: query,
    mode: "hybrid",
    topK: options.topK ?? 5,
    candidateLimit: options.candidateLimit ?? 20,
    durationMs: 1,
    chunkIds: [],
    scoreSummary: []
  };
}

test("multi-source retriever merges legs, dedupes by chunkId and tags sourceKind", async () => {
  const shared = makeRetrievedChunk({ chunkId: "shared_chunk_0000", text: "共享候选", source: "s" });
  const attachmentOnly = makeRetrievedChunk({ chunkId: "a_chunk_0000", text: "附件独有", source: "a" });
  const internalOnly = makeRetrievedChunk({ chunkId: "i_chunk_0000", text: "内部独有", source: "i" });

  const attachmentRetriever = makeStubRetriever({ results: [shared, attachmentOnly] });
  const internalRetriever = makeStubRetriever({ results: [shared, internalOnly] });
  const retriever = createMultiSourceRetriever({
    legs: [
      { sourceKind: "attachment", retriever: attachmentRetriever },
      { sourceKind: "internal", retriever: internalRetriever }
    ],
    topK: 10
  });

  const result = await retriever.retrieve("查询");

  assert.equal(result.ok, true);
  const ids = result.results.map((item) => item.chunk.chunkId);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes("shared_chunk_0000"));

  // leg 顺序即优先级：shared 先被 attachment 路命中，sourceKind 保留 attachment。
  const sharedResult = result.results.find((item) => item.chunk.chunkId === "shared_chunk_0000");
  assert.equal(sharedResult.sourceKind, "attachment");

  assert.equal(result.trace.mode, "hybrid");
  const sharedSummary = result.trace.scoreSummary.find((item) => item.chunkId === "shared_chunk_0000");
  assert.equal(sharedSummary.sourceKind, "attachment");

  // 每条 leg 以 rerank:false 的中间态召回（合并后统一精排一次）。
  assert.equal(attachmentRetriever.calls[0].options.rerank, false);
  assert.equal(internalRetriever.calls[0].options.rerank, false);
});

test("multi-source retriever reranks merged candidates once and renumbers rank", async () => {
  const irrelevant = makeRetrievedChunk({ chunkId: "z_chunk_0000", text: "完全无关的内容", source: "z" });
  const relevant = makeRetrievedChunk({ chunkId: "a_chunk_0000", text: "净利润 10 亿元", source: "a" });
  const retriever = createMultiSourceRetriever({
    legs: [{ sourceKind: "internal", retriever: makeStubRetriever({ results: [irrelevant, relevant] }) }],
    topK: 5
  });

  const result = await retriever.retrieve("净利润");

  assert.equal(result.ok, true);
  // 默认 heuristic reranker 让命中 query 词的候选排到第一。
  assert.equal(result.results[0].chunk.chunkId, "a_chunk_0000");
  assert.deepEqual(result.results.map((item) => item.rank), [1, 2]);
  assert.ok(result.results.every((item) => typeof item.scoreBreakdown.rerankScore === "number"));
});

test("multi-source retriever degrades to the surviving leg when one leg fails", async () => {
  const okRetriever = makeStubRetriever({
    results: [makeRetrievedChunk({ chunkId: "a_chunk_0000", text: "附件候选", source: "a" })]
  });
  const failingRetriever = makeStubRetriever({ fail: true });
  const retriever = createMultiSourceRetriever({
    legs: [
      { sourceKind: "internal", retriever: failingRetriever },
      { sourceKind: "attachment", retriever: okRetriever }
    ],
    topK: 5
  });

  const result = await retriever.retrieve("查询");

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].sourceKind, "attachment");
});

test("multi-source retriever returns ok:false with the first error when all legs fail", async () => {
  const retriever = createMultiSourceRetriever({
    legs: [
      { sourceKind: "attachment", retriever: makeStubRetriever({ fail: true }) },
      { sourceKind: "internal", retriever: makeStubRetriever({ fail: true }) }
    ],
    topK: 5
  });

  const result = await retriever.retrieve("查询");

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "retrieval_failed");
  assert.equal(result.trace.mode, "hybrid");
  assert.deepEqual(result.trace.chunkIds, []);
});

test("multi-source retriever returns an empty successful result when there are no legs", async () => {
  const retriever = createMultiSourceRetriever({ legs: [] });

  const result = await retriever.retrieve("查询");

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
  assert.equal(result.trace.mode, "hybrid");
  assert.deepEqual(result.trace.chunkIds, []);
});
