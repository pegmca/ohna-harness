import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createContextualChunkEnricher,
  createLlmContextPrefixGenerator,
  createNoopContextualEnricher
} from "../dist/contextual-retrieval.js";

/**
 * 构造一个最小的 IngestedFilingDocumentDto，仅保留 enricher 用到的字段。
 */
function makeDocument(title, headings = []) {
  return {
    documentId: "doc_1",
    source: "local://report.md",
    fileName: "report.md",
    title,
    fileType: "markdown",
    createdAt: "2024-01-01T00:00:00.000Z",
    metadata: {},
    blocks: headings.map((heading, index) => ({
      id: `doc_1_block_${String(index + 1).padStart(4, "0")}`,
      text: heading,
      heading,
      lineStart: index + 1,
      lineEnd: index + 1,
      metadata: {}
    }))
  };
}

/**
 * 构造两个最小 RagChunk，仅保留 enricher 用到的字段。
 */
function makeChunks() {
  return [
    {
      chunkId: "c0",
      id: "c0",
      documentId: "doc_1",
      source: "local://report.md",
      chunkIndex: 0,
      text: "原始文本A",
      charStart: 0,
      charEnd: 5,
      startOffset: 0,
      endOffset: 5,
      pageNumber: null,
      heading: null,
      metadata: {}
    },
    {
      chunkId: "c1",
      id: "c1",
      documentId: "doc_1",
      source: "local://report.md",
      chunkIndex: 1,
      text: "原始文本B",
      charStart: 6,
      charEnd: 11,
      startOffset: 6,
      endOffset: 11,
      pageNumber: null,
      heading: null,
      metadata: {}
    }
  ];
}

test("noop enricher returns chunks unchanged", async () => {
  const enrich = createNoopContextualEnricher();
  const chunks = makeChunks();
  const out = await enrich(makeDocument("测试财报"), chunks);

  assert.deepEqual(out, chunks);
});

test("enricher prepends generated context prefix to every chunk", async () => {
  const enrich = createContextualChunkEnricher({ generateContextPrefix: async () => "DOCCTX" });
  const chunks = makeChunks();
  const out = await enrich(makeDocument("测试财报"), chunks);

  assert.equal(out.length, 2);
  assert.ok(out[0].text.startsWith("DOCCTX"));
  assert.ok(out[0].text.includes("原始文本A"));
  assert.ok(out[1].text.startsWith("DOCCTX"));
  assert.ok(out[1].text.includes("原始文本B"));
});

test("enricher keeps chunk unchanged when prefix is empty", async () => {
  const enrich = createContextualChunkEnricher({ generateContextPrefix: async () => "   " });
  const chunks = makeChunks();
  const out = await enrich(makeDocument("测试财报"), chunks);

  assert.deepEqual(out, chunks);
});

test("enricher degrades gracefully when generator throws (no throw)", async () => {
  const enrich = createContextualChunkEnricher({
    generateContextPrefix: async () => {
      throw new Error("boom");
    }
  });
  const chunks = makeChunks();
  // 不抛异常，返回原样 chunks。
  const out = await enrich(makeDocument("测试财报"), chunks);

  assert.deepEqual(out, chunks);
});

test("llm generator returns empty string on fetch failure (graceful)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  try {
    const gen = createLlmContextPrefixGenerator({ baseUrl: "http://example", apiKey: "k", model: "m" });
    const prefix = await gen(makeDocument("测试财报", ["管理层讨论"]));
    assert.equal(prefix, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("llm generator returns trimmed content on success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "  这是一份年度财报摘要。  " } }] })
  });

  try {
    const gen = createLlmContextPrefixGenerator({ baseUrl: "http://example", apiKey: "k", model: "m" });
    const prefix = await gen(makeDocument("测试财报", ["管理层讨论"]));
    assert.equal(prefix, "这是一份年度财报摘要。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
