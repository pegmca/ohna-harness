import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenAiCompatibleReranker,
  createRerankerFromEnv
} from "../dist/reranking-providers.js";
import { BRIDGE_ENV } from "../dist/bridge-config.js";

/**
 * 构造一个合法的 EmbeddedChunk（只填检索/rerank 所需字段）。
 */
function makeChunk(chunkId, chunkIndex, text, hybridScore) {
  const chunk = {
    chunkId,
    id: chunkId,
    documentId: "doc-1",
    source: "mock://src",
    chunkIndex,
    text,
    charStart: chunkIndex * 100,
    charEnd: chunkIndex * 100 + text.length,
    startOffset: chunkIndex * 100,
    endOffset: chunkIndex * 100 + text.length,
    embedding: [0.1, 0.2],
    embeddingModel: "mock-embed",
    metadata: {}
  };
  return {
    chunk,
    rank: chunkIndex + 1,
    score: hybridScore,
    scoreBreakdown: {
      vectorScore: hybridScore,
      keywordScore: 0,
      hybridScore,
      finalScore: hybridScore,
      vectorWeight: 1,
      keywordWeight: 0,
      matchedTerms: [],
      queryTermCoverage: 0,
      headingMatch: false
    }
  };
}

/**
 * 三个候选：输入顺序按 hybridScore 递减（0.9 / 0.8 / 0.7）。
 * judge / rerank 给的分数会让中间 chunk（c1）反超到最前，用于验证排序生效。
 */
function makeCandidates() {
  return [
    makeChunk("c0", 0, "净利润与 ROE 指标说明", 0.9),
    makeChunk("c1", 1, "资产质量与不良率分析", 0.8),
    makeChunk("c2", 2, "现金流概览", 0.7)
  ];
}

/** 用给定实现替换全局 fetch，返回恢复函数。 */
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * 模拟 /rerank 端点返回正常相关分（c1 最相关）。
 */
function buildRerankOkPayload(documents) {
  return {
    model: "test-rerank",
    results: documents.map((_, index) => ({
      index,
      relevance_score: [0.1, 0.95, 0.5][index]
    }))
  };
}

test("rerank 端点返回正常 scores → 更相关的 chunk 排到更前", async () => {
  const candidates = makeCandidates();
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, "http://bridge.test/v1/rerank");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "test-rerank");
    assert.deepEqual(body.documents, candidates.map((c) => c.chunk.text));
    assert.equal(body.top_n, candidates.length);
    return new Response(JSON.stringify(buildRerankOkPayload(body.documents)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  try {
    const reranker = createOpenAiCompatibleReranker({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "test-rerank"
    });
    const result = await reranker.rerank("资产质量 不良率", candidates);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((r) => r.chunk.chunkId), ["c1", "c0", "c2"]);
    // rerankScore 与 finalScore 已写入。
    assert.equal(result.results[0].scoreBreakdown.rerankScore, 0.95);
    assert.ok(result.results[0].scoreBreakdown.finalScore > 0.8);
    // rank 重排为 1..N。
    assert.deepEqual(result.results.map((r) => r.rank), [1, 2, 3]);
  } finally {
    restore();
  }
});

test("rerank 端点 404 → 自动走 LLM-judge 回退并正确排序", async () => {
  const candidates = makeCandidates();
  const restore = stubFetch(async (url, init) => {
    if (url.endsWith("/rerank")) {
      // bridge 不支持 /rerank：返回 404，应触发 judge 回退。
      return new Response("not found", { status: 404 });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(init.body);
      assert.equal(body.model, "test-rerank");
      // 校验 judge prompt 含 query 与编号文档。
      const userContent = body.messages[1].content;
      assert.match(userContent, /资产质量/);
      assert.match(userContent, /\[0\]/);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "[0.1, 0.95, 0.5]" } }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const reranker = createOpenAiCompatibleReranker({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "test-rerank"
    });
    const result = await reranker.rerank("资产质量 不良率", candidates);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((r) => r.chunk.chunkId), ["c1", "c0", "c2"]);
    assert.equal(result.results[0].scoreBreakdown.rerankScore, 0.95);
  } finally {
    restore();
  }
});

test("两次调用都失败 → 安全回退为原 hybridScore 顺序，不抛异常", async () => {
  const candidates = makeCandidates();
  const restore = stubFetch(async (url) => {
    // 两个端点都 500。
    return new Response("boom", { status: 500 });
  });

  try {
    const reranker = createOpenAiCompatibleReranker({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "test-rerank"
    });
    const result = await reranker.rerank("资产质量 不良率", candidates);

    assert.equal(result.ok, true);
    // 回退为 hybridScore 降序：c0(0.9) > c1(0.8) > c2(0.7)。
    assert.deepEqual(result.results.map((r) => r.chunk.chunkId), ["c0", "c1", "c2"]);
    // rerankScore 兜底为原 hybridScore，finalScore == hybridScore。
    assert.equal(result.results[0].scoreBreakdown.rerankScore, 0.9);
    assert.equal(result.results[0].scoreBreakdown.finalScore, 0.9);
  } finally {
    restore();
  }
});

test("judge 返回带围栏的 JSON 也能容错解析", async () => {
  const candidates = makeCandidates();
  const restore = stubFetch(async (url) => {
    if (url.endsWith("/rerank")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "```json\n[0.1, 0.95, 0.5]\n```" } }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const reranker = createOpenAiCompatibleReranker({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "test-rerank"
    });
    const result = await reranker.rerank("资产质量 不良率", candidates);
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((r) => r.chunk.chunkId), ["c1", "c0", "c2"]);
  } finally {
    restore();
  }
});

test("createRerankerFromEnv：env 缺失时返回 heuristic（不发起网络请求）", async () => {
  const saved = {};
  for (const key of Object.values(BRIDGE_ENV)) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  let fetchCalled = false;
  const restore = stubFetch(async () => {
    fetchCalled = true;
    return new Response("boom", { status: 500 });
  });

  try {
    const reranker = createRerankerFromEnv();
    const candidates = makeCandidates();
    const result = await reranker.rerank("资产质量 不良率", candidates);

    // heuristic 不调用 fetch；验证回退为 mock/heuristic 实现。
    assert.equal(fetchCalled, false);
    assert.equal(result.ok, true);
    assert.equal(result.results.length, candidates.length);
  } finally {
    restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
