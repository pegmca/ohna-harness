import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkDocumentBlocks,
  chunkIngestedFilingDocument,
  chunkText,
  createDeterministicMockEmbeddingClient,
  createDataSourceRuntime,
  createHeuristicReranker,
  createHybridRetriever,
  createInMemoryRagDocumentRepository,
  createInMemoryVectorStore,
  createRagAnswer,
  createRagPackageSummary,
  DEFAULT_CHUNKING_OPTIONS,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_VECTOR_SEARCH_TOP_K,
  DEFAULT_VECTOR_WEIGHT,
  isSafeRagSourceUri,
  MAX_VECTOR_SEARCH_TOP_K,
  normalizeRagSourceUri
} from "../dist/index.js";

test("rag package entry exposes its boundary summary", () => {
  const summary = createRagPackageSummary();

  assert.equal(summary.packageName, "@aiagent/rag");
  assert.equal(summary.boundary, "chunking_embedding_retrieval_citation_answer");
  assert.equal(summary.runtimeState, "hybrid_retrieval_ready");
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

test("deterministic mock embedding returns stable vectors and usage", async () => {
  const client = createDeterministicMockEmbeddingClient({
    model: "mock-test",
    dimensions: 12
  });

  const first = await client.embedTexts(["净利润同比增长", "现金流改善"]);
  const second = await client.embedTexts(["净利润同比增长", "现金流改善"]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.model, "mock-test");
  assert.equal(first.dimensions, 12);
  assert.equal(first.usage.inputTexts, 2);
  assert.equal(first.usage.inputCharacters, "净利润同比增长现金流改善".length);
  assert.deepEqual(first.embeddings[0].vector, second.embeddings[0].vector);
  assert.deepEqual(first.embeddings[1].vector, second.embeddings[1].vector);
  assert.notDeepEqual(first.embeddings[0].vector, first.embeddings[1].vector);
});

test("deterministic mock embedding validates dimensions", async () => {
  const client = createDeterministicMockEmbeddingClient({
    dimensions: 0
  });

  const result = await client.embedTexts(["任意文本"]);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_embedding_input");
  assert.equal(result.error.details.dimensions, 0);
});

test("in-memory vector store searches topK by cosine similarity", async () => {
  const client = createDeterministicMockEmbeddingClient({
    dimensions: 24
  });
  const chunkResult = chunkText(
    {
      documentId: "doc_vector",
      source: "mock://vector",
      text: "净利润同比增长。\n\n资产质量保持稳定。\n\n现金流短期承压。"
    },
    {
      strategy: "fixed_size",
      maxChars: 12,
      overlapChars: 0
    }
  );

  assert.equal(chunkResult.ok, true);

  const embeddingResult = await client.embedTexts(chunkResult.chunks.map((chunk) => chunk.text));

  assert.equal(embeddingResult.ok, true);

  const embeddedChunks = chunkResult.chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddingResult.embeddings[index].vector,
    embeddingModel: embeddingResult.model
  }));
  const store = createInMemoryVectorStore();
  const upsertResult = await store.upsertChunks(embeddedChunks);
  const queryEmbedding = await client.embedTexts(["净利润增长"]);

  assert.equal(upsertResult.ok, true);
  assert.equal(upsertResult.upsertedCount, embeddedChunks.length);
  assert.equal(upsertResult.replacedCount, 0);
  assert.equal(queryEmbedding.ok, true);

  const searchResult = await store.search(queryEmbedding.embeddings[0].vector, {
    topK: 2
  });

  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.matches.length, 2);
  assert.equal(searchResult.matches[0].rank, 1);
  assert.match(searchResult.matches[0].chunk.text, /净利润/);
  assert.ok(searchResult.matches[0].score >= searchResult.matches[1].score);
});

test("in-memory vector store returns empty result for empty index", async () => {
  const store = createInMemoryVectorStore({
    dimensions: 3
  });

  const result = await store.search([1, 0, 0]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.matches, []);
});

test("in-memory vector store replaces chunks with the same chunkId", async () => {
  const store = createInMemoryVectorStore({
    dimensions: 3
  });
  const baseChunk = {
    chunkId: "replace_chunk",
    id: "replace_chunk",
    documentId: "doc_replace",
    source: "mock://replace",
    chunkIndex: 0,
    text: "旧文本",
    charStart: 0,
    charEnd: 3,
    startOffset: 0,
    endOffset: 3,
    metadata: {},
    embedding: [1, 0, 0],
    embeddingModel: "mock"
  };

  const first = await store.upsertChunks([baseChunk]);
  const second = await store.upsertChunks([
    {
      ...baseChunk,
      text: "新文本",
      embedding: [0, 1, 0]
    }
  ]);
  const searchResult = await store.search([0, 1, 0], {
    topK: 1
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replacedCount, 1);
  assert.equal(second.totalCount, 1);
  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.matches[0].chunk.text, "新文本");
});

test("in-memory vector store filters by documentId and source", async () => {
  const store = createInMemoryVectorStore({
    dimensions: 2
  });

  const upsertResult = await store.upsertChunks([
    createEmbeddedTestChunk("chunk_a", "doc_a", "mock://a", "A", [1, 0]),
    createEmbeddedTestChunk("chunk_b", "doc_b", "mock://b", "B", [0.8, 0.2]),
    createEmbeddedTestChunk("chunk_c", "doc_b", "mock://c", "C", [0, 1])
  ]);

  assert.equal(upsertResult.ok, true);

  const documentFiltered = await store.search([1, 0], {
    topK: 3,
    filter: {
      documentId: "doc_b"
    }
  });
  const sourceFiltered = await store.search([1, 0], {
    topK: 3,
    filter: {
      source: "mock://c"
    }
  });

  assert.equal(documentFiltered.ok, true);
  assert.deepEqual(
    documentFiltered.matches.map((match) => match.chunk.chunkId),
    ["chunk_b", "chunk_c"]
  );
  assert.equal(sourceFiltered.ok, true);
  assert.deepEqual(
    sourceFiltered.matches.map((match) => match.chunk.chunkId),
    ["chunk_c"]
  );
});

test("in-memory vector store returns structured errors for dimension mismatch", async () => {
  const store = createInMemoryVectorStore({
    dimensions: 3
  });

  const upsertResult = await store.upsertChunks([
    createEmbeddedTestChunk("bad_chunk", "doc_bad", "mock://bad", "bad", [1, 0])
  ]);

  assert.equal(upsertResult.ok, false);
  assert.equal(upsertResult.error.code, "embedding_dimension_mismatch");
  assert.equal(upsertResult.error.details.expectedDimensions, 3);
  assert.equal(upsertResult.error.details.actualDimensions, 2);

  const validUpsert = await store.upsertChunks([
    createEmbeddedTestChunk("good_chunk", "doc_good", "mock://good", "good", [1, 0, 0])
  ]);
  const searchResult = await store.search([1, 0]);

  assert.equal(validUpsert.ok, true);
  assert.equal(searchResult.ok, false);
  assert.equal(searchResult.error.code, "vector_store_dimension_mismatch");
  assert.equal(searchResult.error.details.expectedDimensions, 3);
  assert.equal(searchResult.error.details.actualDimensions, 2);
});

test("in-memory vector store applies default and maximum topK", async () => {
  const store = createInMemoryVectorStore({
    dimensions: 2
  });
  const chunks = Array.from({ length: MAX_VECTOR_SEARCH_TOP_K + 5 }, (_, index) =>
    createEmbeddedTestChunk(`chunk_${index}`, "doc_topk", "mock://topk", `chunk ${index}`, [1, 0])
  );
  const upsertResult = await store.upsertChunks(chunks);

  assert.equal(upsertResult.ok, true);

  const defaultResult = await store.search([1, 0]);
  const cappedResult = await store.search([1, 0], {
    topK: MAX_VECTOR_SEARCH_TOP_K + 100
  });
  const invalidResult = await store.search([1, 0], {
    topK: 0
  });

  assert.equal(defaultResult.ok, true);
  assert.equal(defaultResult.matches.length, DEFAULT_VECTOR_SEARCH_TOP_K);
  assert.equal(cappedResult.ok, true);
  assert.equal(cappedResult.matches.length, MAX_VECTOR_SEARCH_TOP_K);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.error.code, "invalid_vector_search_options");
});

test("hybrid retriever supports vector-only mode with score breakdown", async () => {
  const { retriever } = await createRetrieverFixture();
  const result = await retriever.retrieve("净利润增长", {
    mode: "vector",
    topK: 2,
    rerank: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].scoreBreakdown.keywordScore, 0);
  assert.equal(result.results[0].scoreBreakdown.vectorWeight, 1);
  assert.equal(result.results[0].scoreBreakdown.keywordWeight, 0);
  assert.equal(result.trace.mode, "vector");
  assert.deepEqual(
    result.trace.chunkIds,
    result.results.map((entry) => entry.chunk.chunkId)
  );
});

test("hybrid retriever supports keyword-only mode and lifts exact financial terms", async () => {
  const { retriever } = await createRetrieverFixture();
  const result = await retriever.retrieve("资产质量", {
    mode: "keyword",
    topK: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].chunk.text, /资产质量/);
  assert.equal(result.results[0].scoreBreakdown.vectorScore, 0);
  assert.equal(result.results[0].scoreBreakdown.vectorWeight, 0);
  assert.equal(result.results[0].scoreBreakdown.keywordWeight, 1);
  assert.ok(result.results[0].scoreBreakdown.keywordScore > 0);
  assert.ok(result.results[0].scoreBreakdown.matchedTerms.includes("资产质量"));
});

test("hybrid retriever merges vector and keyword candidates with final score explanation", async () => {
  const { retriever } = await createRetrieverFixture();
  const result = await retriever.retrieve("净利润 ROE", {
    mode: "hybrid",
    topK: 3,
    candidateLimit: 4,
    rerank: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 3);
  assert.equal(result.trace.candidateLimit, 4);
  assert.equal(result.results[0].scoreBreakdown.vectorWeight, DEFAULT_VECTOR_WEIGHT);
  assert.equal(result.results[0].scoreBreakdown.keywordWeight, DEFAULT_KEYWORD_WEIGHT);
  assert.ok(result.results.some((entry) => /ROE/.test(entry.chunk.text)));
  assert.ok(
    result.results.every(
      (entry) =>
        typeof entry.scoreBreakdown.vectorScore === "number" &&
        typeof entry.scoreBreakdown.keywordScore === "number" &&
        entry.scoreBreakdown.finalScore === entry.score
    )
  );
  assert.deepEqual(
    result.trace.scoreSummary.map((entry) => entry.chunkId),
    result.results.map((entry) => entry.chunk.chunkId)
  );
});

test("heuristic reranker is stable and explains coverage and heading matches", async () => {
  const reranker = createHeuristicReranker();
  const first = createRetrievedTestChunk(
    {
      ...createEmbeddedTestChunk("tie_b", "doc_tie", "mock://tie", "资产质量", [1, 0]),
      chunkIndex: 0,
      heading: "资产质量"
    },
    0.5
  );
  const second = createRetrievedTestChunk(
    {
      ...createEmbeddedTestChunk("tie_a", "doc_tie", "mock://tie", "资产质量", [1, 0]),
      chunkIndex: 0,
      heading: "资产质量"
    },
    0.5
  );
  const result = await reranker.rerank("资产质量", [first, second]);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.results.map((entry) => entry.chunk.chunkId),
    ["tie_a", "tie_b"]
  );
  assert.equal(result.results[0].scoreBreakdown.headingMatch, true);
  assert.equal(result.results[0].scoreBreakdown.queryTermCoverage, 1);
  assert.equal(typeof result.results[0].scoreBreakdown.rerankScore, "number");
});

test("hybrid retriever enforces topK, candidateLimit and structured option errors", async () => {
  const { retriever } = await createRetrieverFixture();
  const limited = await retriever.retrieve("净利润 资产质量 ROE", {
    mode: "hybrid",
    topK: 3,
    candidateLimit: 2
  });
  const invalid = await retriever.retrieve("净利润", {
    candidateLimit: 0
  });

  assert.equal(limited.ok, true);
  assert.equal(limited.results.length, 2);
  assert.equal(limited.trace.topK, 3);
  assert.equal(limited.trace.candidateLimit, 2);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_retrieval_options");
});

test("rag answer can express citations and retrieval results", () => {
  const answer = createRagAnswer({
    answer: "公司净利润同比增长，依据年报管理层讨论章节。",
    citations: [
      {
        chunkId: "chunk_001",
        documentId: "doc_001",
        source: "mock://annual-report.md",
        heading: "管理层讨论",
        chunkIndex: 0,
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
          source: "mock://annual-report.md",
          heading: "管理层讨论",
          chunkIndex: 0,
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

test("data source runtime ingests, searches and answers with traceable citations", async () => {
  const runtime = createDataSourceRuntime();
  const ingestResult = await runtime.ingest({
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。\n\n# 盈利能力\n公司净利润同比增长。"
  });

  assert.equal(ingestResult.ok, true);
  assert.equal(ingestResult.data.documentVersion, 1);
  assert.equal(ingestResult.data.deduplicated, false);

  const documentsPage = await runtime.listDocuments();
  const chunksPage = await runtime.listChunks();

  assert.equal(documentsPage.documents.length, 1);
  assert.equal(documentsPage.nextCursor, null);
  assert.equal(documentsPage.documents[0].latestVersion, 1);
  assert.equal(documentsPage.documents[0].latestStatus, "indexed");
  assert.equal(documentsPage.documents[0].scope, "shared");
  assert.equal(chunksPage.chunks.length, ingestResult.data.indexedChunkCount);
  assert.equal(chunksPage.chunks[0].documentId, documentsPage.documents[0].documentId);

  const searchResult = await runtime.search("资产质量", {
    topK: 3
  });

  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.data.results.length > 0, true);
  assert.equal(searchResult.data.results[0].citation.source, "demo");
  assert.equal(searchResult.data.results[0].citation.heading, "资产质量");
  assert.equal(typeof searchResult.data.results[0].citation.chunkIndex, "number");

  const answerResult = await runtime.answer("公司资产质量如何？", {
    topK: 3
  });

  assert.equal(answerResult.ok, true);
  assert.match(answerResult.data.answer.answer, /资料|摘要|资产质量|不良率/);
  assert.equal(answerResult.data.answer.citations[0].source, "demo");
  assert.equal(answerResult.data.trace.ok, true);
});

test("data source runtime applies unknown answer policy when evidence is missing", async () => {
  const runtime = createDataSourceRuntime();
  const ingestResult = await runtime.ingest({
    source: "demo",
    fileName: "annual-report.md",
    content: "# 资产质量\n公司不良率保持稳定。"
  });
  const answerResult = await runtime.answer("公司海外新能源业务收入是多少？", {
    topK: 3
  });

  assert.equal(ingestResult.ok, true);
  assert.equal(answerResult.ok, true);
  assert.match(answerResult.data.answer.answer, /资料不足|无法可靠回答/);
});

test("re-ingesting identical content is deduplicated without new versions or chunks", async () => {
  const repository = createInMemoryRagDocumentRepository();
  const runtime = createDataSourceRuntime({ repository });
  const request = {
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };
  const first = await runtime.ingest(request);
  const second = await runtime.ingest(request);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.data.deduplicated, false);
  assert.equal(second.data.deduplicated, true);
  assert.equal(second.data.documentVersion, first.data.documentVersion);
  assert.deepEqual(
    second.data.chunks.map((chunk) => chunk.chunkId),
    first.data.chunks.map((chunk) => chunk.chunkId)
  );

  const versions = await repository.listVersions({ documentId: first.data.document.documentId, ownerUserId: null });
  const chunksPage = await runtime.listChunks();

  assert.equal(versions.length, 1);
  assert.equal(chunksPage.chunks.length, first.data.indexedChunkCount);

  const searchResult = await runtime.search("不良率", { topK: 1 });
  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.data.results.length, 1);
});

test("new content creates an immutable new version and keeps old chunks", async () => {
  const repository = createInMemoryRagDocumentRepository();
  const runtime = createDataSourceRuntime({ repository });
  const base = { source: "demo", fileName: "annual-report.md", contentType: "text/markdown" };
  const first = await runtime.ingest({ ...base, content: "# 资产质量\n公司不良率保持稳定。" });
  const second = await runtime.ingest({ ...base, content: "# 资产质量\n公司不良率上升，拨备覆盖率下降。" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.data.deduplicated, false);
  assert.equal(second.data.documentVersion, first.data.documentVersion + 1);
  assert.equal(second.data.document.documentId, first.data.document.documentId);

  const versions = await repository.listVersions({ documentId: first.data.document.documentId, ownerUserId: null });
  const chunksPage = await runtime.listChunks();
  const documentsPage = await runtime.listDocuments();

  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((version) => version.version), [1, 2]);
  assert.ok(versions.every((version) => version.status === "indexed"));
  assert.equal(chunksPage.chunks.length, first.data.indexedChunkCount + second.data.indexedChunkCount);
  assert.equal(documentsPage.documents.length, 1);
  assert.equal(documentsPage.documents[0].latestVersion, 2);

  // 不同版本相同 chunkIndex 的 chunkId 必须不同（版本身份是 citation 回链目标），
  // 且 listChunks(documentId) 能同时读到 v1 和 v2 的 chunks（旧 citation 目标仍存在）。
  const firstChunkIds = new Set(first.data.chunks.map((chunk) => chunk.chunkId));
  const secondChunkIds = new Set(second.data.chunks.map((chunk) => chunk.chunkId));
  assert.ok([...secondChunkIds].every((chunkId) => !firstChunkIds.has(chunkId)));
  const documentChunks = await runtime.listChunks({ documentId: first.data.document.documentId });
  const persistedChunkIds = new Set(documentChunks.chunks.map((chunk) => chunk.chunkId));
  assert.ok([...firstChunkIds].every((chunkId) => persistedChunkIds.has(chunkId)));
  assert.ok([...secondChunkIds].every((chunkId) => persistedChunkIds.has(chunkId)));
});

test("failed ingestion is persisted with structured error and can be inspected", async () => {
  const repository = createInMemoryRagDocumentRepository();
  const runtime = createDataSourceRuntime({ repository });
  const result = await runtime.ingest({
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "   "
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ingestion_failed");
  assert.equal(result.error.details.filingCode, "empty_file");

  const documentsPage = await runtime.listDocuments();

  assert.equal(documentsPage.documents.length, 1);
  assert.equal(documentsPage.documents[0].latestStatus, "failed");

  const versions = await repository.listVersions({ documentId: documentsPage.documents[0].documentId, ownerUserId: null });

  assert.equal(versions.length, 1);
  assert.equal(versions[0].status, "failed");
  assert.equal(versions[0].error.code, "empty_file");
  assert.equal(typeof versions[0].error.message, "string");

  const retry = await runtime.ingest({
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  });

  assert.equal(retry.ok, true);
  assert.equal(retry.data.documentVersion, 2);
  assert.equal(retry.data.deduplicated, false);

  const versionsAfterRetry = await repository.listVersions({ documentId: documentsPage.documents[0].documentId, ownerUserId: null });

  assert.equal(versionsAfterRetry.length, 2);
  assert.deepEqual(versionsAfterRetry.map((version) => version.status), ["failed", "indexed"]);
});

test("retrying the same failed content updates the failed version in place", async () => {
  const repository = createInMemoryRagDocumentRepository();
  const runtime = createDataSourceRuntime({ repository });
  const request = {
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "   "
  };
  const first = await runtime.ingest(request);
  const second = await runtime.ingest(request);

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);

  const documentsPage = await runtime.listDocuments();
  const versions = await repository.listVersions({ documentId: documentsPage.documents[0].documentId, ownerUserId: null });

  assert.equal(documentsPage.documents.length, 1);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].status, "failed");
});

test("private documents are only visible to their owner", async () => {
  const runtime = createDataSourceRuntime();
  const ingestResult = await runtime.ingest(
    {
      source: "demo",
      fileName: "annual-report.md",
      contentType: "text/markdown",
      content: "# 资产质量\n公司不良率保持稳定。"
    },
    { ownerUserId: "user-a" }
  );

  assert.equal(ingestResult.ok, true);

  const ownerPage = await runtime.listDocuments({ ownerUserId: "user-a" });
  const otherPage = await runtime.listDocuments({ ownerUserId: "user-b" });
  const anonymousPage = await runtime.listDocuments();
  const ownerChunks = await runtime.listChunks({ ownerUserId: "user-a" });
  const otherChunks = await runtime.listChunks({ ownerUserId: "user-b" });

  assert.equal(ownerPage.documents.length, 1);
  assert.equal(ownerPage.documents[0].scope, "private");
  assert.equal(otherPage.documents.length, 0);
  assert.equal(anonymousPage.documents.length, 0);
  assert.equal(ownerChunks.chunks.length, ingestResult.data.indexedChunkCount);
  assert.equal(otherChunks.chunks.length, 0);
});

test("ingest rejects illegal owner/scope combinations with a structured error", async () => {
  const repository = createInMemoryRagDocumentRepository();
  const runtime = createDataSourceRuntime({ repository });
  const request = {
    source: "demo",
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };

  const ownerWithShared = await runtime.ingest(request, { ownerUserId: "user-a", scope: "shared" });
  const ownerWithDemo = await runtime.ingest(request, { ownerUserId: "user-a", scope: "demo" });

  assert.equal(ownerWithShared.ok, false);
  assert.equal(ownerWithShared.error.code, "ingestion_failed");
  assert.match(String(ownerWithShared.error.details.reason), /shared\/demo/);
  assert.equal(ownerWithDemo.ok, false);
  assert.equal((await runtime.listDocuments()).documents.length, 0);
  assert.equal((await runtime.listDocuments({ ownerUserId: "user-a" })).documents.length, 0);

  await assert.rejects(
    repository.saveIngestion({
      ownerUserId: null,
      scope: "private",
      sourceType: "mock_text",
      externalId: "ext-invalid",
      title: "非法组合",
      sourceUri: "demo",
      contentType: "text/markdown",
      contentChecksum: "checksum-invalid",
      content: "内容",
      parserVersion: "test",
      chunkerVersion: "test",
      outcome: { status: "failed", error: { code: "empty_file", message: "空" } },
      now: "2026-01-01T00:00:00.000Z"
    }),
    (error) => {
      assert.equal(error.name, "RagOwnerScopeValidationError");
      assert.equal(error.code, "validation_failed");
      return true;
    }
  );
});

test("ingest rejects unsafe source identifiers without persisting anything", async () => {
  const runtime = createDataSourceRuntime();
  const request = {
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };
  const unsafeSources = [
    "/etc/passwd",
    "~/secret.md",
    "C:\\data\\x.md",
    "C:/data/x.md",
    "file:///etc/passwd",
    "../escape",
    "a/../../b",
    "bad\ttab",
    "back\\slash",
    "https://user:pass@example.com/x.md",
    "https://user@example.com/x.md"
  ];

  for (const source of unsafeSources) {
    const result = await runtime.ingest({ ...request, source });
    assert.equal(result.ok, false, `source ${source} should be rejected`);
    assert.equal(result.error.code, "ingestion_failed");
    assert.equal(result.error.details.reason, "unsafe_source_uri");
  }

  assert.equal(isSafeRagSourceUri("demo"), true);
  assert.equal(isSafeRagSourceUri("demo/annual-report"), true);
  assert.equal(isSafeRagSourceUri("mock://filings/000001.SZ/2025-annual.md"), true);
  assert.equal(isSafeRagSourceUri("https://example.com/filing.md?token=abc"), true);
  assert.equal(isSafeRagSourceUri("local://annual-report.md"), true);
  assert.equal(isSafeRagSourceUri("https://user:pass@example.com/x.md"), false);
  assert.equal(isSafeRagSourceUri("https://user@example.com/x.md"), false);

  assert.equal((await runtime.listDocuments()).documents.length, 0);
  assert.equal((await runtime.listChunks()).chunks.length, 0);
});

test("signed http source is normalized so lineage and DTOs never contain query or fragment", async () => {
  const runtime = createDataSourceRuntime();
  const request = {
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };
  const signed = await runtime.ingest({ ...request, source: "https://example.com/filing.md?token=abc&signature=y#frag" });

  assert.equal(signed.ok, true);
  assert.equal(signed.data.document.source, "https://example.com/filing.md");
  assert.ok(signed.data.chunks.every((chunk) => chunk.source === "https://example.com/filing.md"));

  // 同一文档不带 token 重复 ingest 命中同一 lineage（幂等）。
  const unsigned = await runtime.ingest({ ...request, source: "https://example.com/filing.md" });
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.data.deduplicated, true);
  assert.equal(unsigned.data.document.documentId, signed.data.document.documentId);

  const documentsPage = await runtime.listDocuments();
  const chunksPage = await runtime.listChunks();

  assert.equal(documentsPage.documents.length, 1);
  assert.equal(documentsPage.documents[0].sourceUri, "https://example.com/filing.md");
  const serialized = JSON.stringify({ documents: documentsPage.documents, chunks: chunksPage.chunks });
  assert.ok(!serialized.includes("token=abc"));
  assert.ok(!serialized.includes("signature=y"));
  assert.ok(!serialized.includes("frag"));

  assert.equal(normalizeRagSourceUri("https://example.com/a/b.md?api_key=x#section"), "https://example.com/a/b.md");
  assert.equal(normalizeRagSourceUri("demo/annual-report"), "demo/annual-report");
  assert.equal(normalizeRagSourceUri("mock://filings/x.md"), "mock://filings/x.md");
});

test("non-sensitive query params stay in source identity while sensitive keys are stripped", async () => {
  const runtime = createDataSourceRuntime();
  const request = {
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };
  const filingA = await runtime.ingest({ ...request, source: "https://example.com/download?id=filing-A" });
  const filingB = await runtime.ingest({ ...request, source: "https://example.com/download?id=filing-B" });

  assert.equal(filingA.ok, true);
  assert.equal(filingB.ok, true);

  // allowlist 标识参数参与 externalId：?id=A 与 ?id=B 是两个不同逻辑文档。
  const twoDocuments = await runtime.listDocuments();
  assert.equal(twoDocuments.documents.length, 2);
  assert.notEqual(filingA.data.document.documentId, filingB.data.document.documentId);
  assert.ok(twoDocuments.documents.some((document) => document.sourceUri === "https://example.com/download?id=filing-A"));
  assert.ok(twoDocuments.documents.some((document) => document.sourceUri === "https://example.com/download?id=filing-B"));

  // 同一资源带凭证参数重复 ingest 命中同一 lineage，凭证键值不持久化。
  const signedA = await runtime.ingest({
    ...request,
    source: "https://example.com/download?id=filing-A&token=secret123&signature=xyz"
  });
  assert.equal(signedA.ok, true);
  assert.equal(signedA.data.deduplicated, true);
  assert.equal(signedA.data.document.documentId, filingA.data.document.documentId);

  const documentsPage = await runtime.listDocuments();
  const chunksPage = await runtime.listChunks();
  const serialized = JSON.stringify({ documents: documentsPage.documents, chunks: chunksPage.chunks });
  assert.ok(serialized.includes("id=filing-A"));
  assert.ok(!serialized.includes("secret123"));
  assert.ok(!serialized.includes("signature=xyz"));
  assert.ok(!serialized.includes("token="));

  // fragment 一律剥离；仅 allowlist 参数保留并排序，其余键（含云签名前缀）一律删除。
  assert.equal(
    normalizeRagSourceUri("https://example.com/a?z=1&id=filing-A#section"),
    "https://example.com/a?id=filing-A"
  );
  assert.equal(
    normalizeRagSourceUri("https://example.com/a?X-Amz-Signature=abc&x-goog-credential=def&id=x"),
    "https://example.com/a?id=x"
  );
  assert.equal(
    normalizeRagSourceUri("https://example.com/a?id=2&id=1&page=0"),
    "https://example.com/a?id=1&id=2&page=0"
  );
});

test("credential-like query variants never reach lineage and still deduplicate per resource", async () => {
  const runtime = createDataSourceRuntime();
  const request = {
    fileName: "annual-report.md",
    contentType: "text/markdown",
    content: "# 资产质量\n公司不良率保持稳定。"
  };
  const plain = await runtime.ingest({ ...request, source: "https://example.com/download?id=filing-A" });
  assert.equal(plain.ok, true);

  // denylist 时代的绕过变体：allowlist 下无论键名如何变形都不会落库。
  const variants = [
    ["accessToken", "tok_1"],
    ["auth_token", "tok_2"],
    ["client_secret", "sec_3"],
    ["session_id", "sess_4"],
    ["code", "oauth_code_5"],
    ["AWSAccessKeyId", "AKIA6"],
    ["GoogleAccessId", "goo_7"]
  ];

  for (const [key, secret] of variants) {
    const result = await runtime.ingest({ ...request, source: `https://example.com/download?id=filing-A&${key}=${secret}` });
    assert.equal(result.ok, true, `${key} variant should ingest`);
    assert.equal(result.data.deduplicated, true, `${key} variant should hit the same lineage`);
    assert.equal(result.data.document.documentId, plain.data.document.documentId);

    const documentsPage = await runtime.listDocuments();
    const chunksPage = await runtime.listChunks();
    const serialized = JSON.stringify({ documents: documentsPage.documents, chunks: chunksPage.chunks });
    assert.ok(!serialized.includes(key), `${key} must not be persisted`);
    assert.ok(!serialized.includes(secret), `${key} secret value must not be persisted`);
  }

  const documentsPage = await runtime.listDocuments();
  assert.equal(documentsPage.documents.length, 1);
  assert.equal(documentsPage.documents[0].sourceUri, "https://example.com/download?id=filing-A");
});

/**
 * 创建测试用 embedded chunk，避免每个 vector store 用例重复构造完整 DTO。
 *
 * @param {string} chunkId chunk 稳定身份。
 * @param {string} documentId 文档身份。
 * @param {string} source 来源 URI。
 * @param {string} text chunk 文本。
 * @param {number[]} embedding 测试向量。
 * @returns {object} 可写入内存向量库的测试 chunk。
 */
function createEmbeddedTestChunk(chunkId, documentId, source, text, embedding) {
  return {
    chunkId,
    id: chunkId,
    documentId,
    source,
    chunkIndex: 0,
    text,
    charStart: 0,
    charEnd: text.length,
    startOffset: 0,
    endOffset: text.length,
    metadata: {},
    embedding,
    embeddingModel: "mock"
  };
}

/**
 * 创建混合检索测试 fixture，复用同一批公告/财报片段。
 *
 * @returns {Promise<{ retriever: import("../dist/index.js").Retriever }>} 检索器 fixture。
 */
async function createRetrieverFixture() {
  const client = createDeterministicMockEmbeddingClient({
    dimensions: 24
  });
  const rawChunks = [
    {
      ...createEmbeddedTestChunk(
        "doc_rag_chunk_0000",
        "doc_rag",
        "mock://rag",
        "公司净利润同比增长，ROE 保持在较高水平。",
        []
      ),
      chunkIndex: 0,
      heading: "盈利能力"
    },
    {
      ...createEmbeddedTestChunk(
        "doc_rag_chunk_0001",
        "doc_rag",
        "mock://rag",
        "资产质量保持稳健，不良贷款率下降。",
        []
      ),
      chunkIndex: 1,
      heading: "资产质量"
    },
    {
      ...createEmbeddedTestChunk(
        "doc_rag_chunk_0002",
        "doc_rag",
        "mock://rag",
        "现金流短期承压，资本开支增加。",
        []
      ),
      chunkIndex: 2,
      heading: "现金流"
    },
    {
      ...createEmbeddedTestChunk(
        "doc_rag_chunk_0003",
        "doc_rag",
        "mock://rag",
        "费用率改善带动经营效率提升。",
        []
      ),
      chunkIndex: 3,
      heading: "经营效率"
    }
  ];
  const embeddingResult = await client.embedTexts(rawChunks.map((chunk) => chunk.text));

  assert.equal(embeddingResult.ok, true);

  const chunks = rawChunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddingResult.embeddings[index].vector,
    embeddingModel: embeddingResult.model
  }));
  const store = createInMemoryVectorStore();
  const upsertResult = await store.upsertChunks(chunks);

  assert.equal(upsertResult.ok, true);

  return {
    retriever: createHybridRetriever({
      embeddingClient: client,
      vectorStore: store,
      chunks
    })
  };
}

/**
 * 创建 rerank 测试候选，便于直接验证 tie-break 和 explanation。
 *
 * @param {object} chunk embedded chunk。
 * @param {number} score 初始分数。
 * @returns {object} RetrievedChunk 形状的测试对象。
 */
function createRetrievedTestChunk(chunk, score) {
  return {
    chunk,
    rank: 0,
    score,
    scoreBreakdown: {
      vectorScore: score,
      keywordScore: score,
      hybridScore: score,
      finalScore: score,
      vectorWeight: 0.5,
      keywordWeight: 0.5,
      matchedTerms: [],
      queryTermCoverage: 0,
      headingMatch: false
    }
  };
}
