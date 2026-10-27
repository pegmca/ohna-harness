import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkDocumentBlocks,
  createCitationFromRetrievedChunk,
  createDataSourceRuntime,
  createHybridRetriever,
  createInMemoryVectorStore,
  resolveChunkerVersion,
  synthesizeRagAnswer
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

/**
 * 构造表格 block。
 *
 * @param {number} index block 序号。
 * @param {string} text 行文本。
 * @param {number} page 页码。
 * @param {boolean} isTableRow 是否为表格行。
 * @param {Record<string, unknown>} metadata 额外 metadata。
 * @returns {Record<string, unknown>} ingestion block 形状。
 */
function block(index, text, page, isTableRow = true, metadata = {}) {
  return {
    id: `doc_block_${String(index).padStart(4, "0")}`,
    text,
    pageNumber: page,
    lineStart: index,
    lineEnd: index,
    metadata: { isTableRow, ...metadata }
  };
}

/**
 * 构造带确定性 embedding 的检索 chunk。
 *
 * @param {string} chunkId chunk id。
 * @param {string} text chunk 文本。
 * @param {Record<string, unknown>} metadata chunk metadata。
 * @param {number[]} embedding 测试向量。
 * @returns {Record<string, unknown>} embedded chunk。
 */
function embedded(chunkId, text, metadata, embedding = [1, 0]) {
  return {
    chunkId,
    id: chunkId,
    documentId: "doc",
    source: "mock://table",
    chunkIndex: Number(chunkId.split("_").at(-1)) || 0,
    text,
    charStart: 0,
    charEnd: text.length,
    startOffset: 0,
    endOffset: text.length,
    metadata,
    embedding,
    embeddingModel: "mock"
  };
}

const TABLE_OPTIONS = {
  strategy: "table_aware",
  maxChars: 80,
  overlapChars: 10,
  tableHeaderFooterMaxChars: 80
};

test("table-aware chunking emits whole-table and summary siblings with shared group metadata", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc",
      source: "mock://table",
      blocks: [
        block(1, "主要控股参股公司", 10, false),
        block(2, "公司名称  注册资本  营业收入", 10),
        block(3, "华美公司  213,252.00  411,947.55", 10),
        block(4, "北方磁材  179,994.71  944,806.24", 10),
        block(5, "天骄清美  934.51  6,785.01", 10)
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  const tables = result.chunks.filter((chunk) => chunk.metadata.isTableChunk === true);
  const summaries = result.chunks.filter((chunk) => chunk.metadata.isTableSummary === true);

  assert.equal(tables.length, 1);
  assert.equal(summaries.length, 1);
  assert.equal(tables[0].metadata.tableGroupId, summaries[0].metadata.tableGroupId);
  assert.equal(tables[0].metadata.tableRowCount, 4);
  assert.match(tables[0].text, /华美公司[\s\S]*北方磁材[\s\S]*天骄清美/);
  assert.match(summaries[0].text, /华美公司、北方磁材、天骄清美/);
  assert.match(summaries[0].text, /4 行/);
  assert.equal(tables[0].metadata.tableHeader, "公司名称  注册资本  营业收入");
  assert.equal(tables[0].metadata.pageStart, 10);
  assert.equal(tables[0].metadata.pageEnd, 10);
});

test("table-aware grouping crosses pages and ignores a short repeated header", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_cross_page",
      source: "mock://cross-page",
      blocks: [
        { ...block(1, "长期应收款", 20, false, { blockRole: "heading", isHeading: true }), heading: "长期应收款" },
        block(2, "项目  期末余额  期初余额", 20),
        block(3, "分期收款销售商品  700,222,895.11  831,609,573.79", 20),
        block(4, "公司 2025 年年度报告", 21, false),
        block(5, "合计  1,276,828,634.92  1,313,254,079.23", 21),
        block(6, "分期收款提供劳务  712,692,492.71  711,689,972.49", 21)
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  const tableChunks = result.chunks.filter((chunk) => chunk.metadata.isTableChunk === true);
  assert.equal(tableChunks.length, 1);
  assert.equal(tableChunks[0].metadata.pageStart, 20);
  assert.equal(tableChunks[0].metadata.pageEnd, 21);
  assert.match(tableChunks[0].text, /分期收款销售商品[\s\S]*分期收款提供劳务/);
  assert.doesNotMatch(tableChunks[0].text, /公司 2025 年年度报告/);
});

test("a real heading ends the current table group", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_heading_end",
      source: "mock://heading-end",
      blocks: [
        block(1, "项目  期末余额  期初余额", 1),
        block(2, "甲  1  2", 1),
        { ...block(3, "其他项目说明", 1, false, { blockRole: "heading", isHeading: true }), heading: "其他项目说明" },
        block(4, "乙  3  4", 1)
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks.filter((chunk) => chunk.metadata.isTableChunk === true).length, 2);
});

test("wrapped non-table cells stay inside the current table group", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_wrapped",
      source: "mock://wrapped",
      blocks: [
        block(1, "公司名称  公司类型  主要业务  营业收入", 1),
        block(2, "华美公司  子公司  稀土产品及其应用产品的  411,947.55", 1),
        block(3, "生产与销售。", 1, false),
        block(4, "甘肃稀土  子公司  稀土产品及相关应用产品  552,988.55", 1)
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  const groups = result.chunks.filter((chunk) => chunk.metadata.isTableChunk === true);
  assert.equal(groups.length, 1);
  assert.match(groups[0].text, /生产与销售。[\s\S]*甘肃稀土/);
});

test("a short wrapped row label before the numeric cells joins that row", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_label_wrap",
      source: "mock://label-wrap",
      blocks: [
        block(1, "类别  期末余额  期初余额", 1),
        block(2, "其中：", 1, false),
        block(3, "按组合", 1, false),
        block(4, "计提坏", 1, false),
        block(5, "2,232.54  100.00%  2,307.77", 1)
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  const tableChunk = result.chunks.find((chunk) => chunk.metadata.isTableChunk === true);
  assert.ok(tableChunk);
  assert.match(tableChunk.text, /其中：按组合计提坏/);
});

test("table column count uses a median and ignores sparse deduction rows", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_median",
      source: "mock://median",
      blocks: [
        block(1, "项目  期末余额  坏账准备  账面价值", 1),
        block(2, "甲", 1, true, { tableColumnCount: 3 }),
        block(3, "其中：未实现融资收益", 1, true, { tableColumnCount: 2 }),
        block(4, "乙", 1, true, { tableColumnCount: 3 }),
        block(5, "丙", 1, true, { tableColumnCount: 3 })
      ]
    },
    TABLE_OPTIONS
  );

  assert.equal(result.ok, true);
  const tableChunk = result.chunks.find((chunk) => chunk.metadata.isTableChunk === true);
  assert.equal(tableChunk?.metadata.tableColumnCount, 3);
});

test("an oversized single table row is never split by maxChars", () => {
  const longRow = `巨额表格行  ${"123,456,789.00  ".repeat(30)}`;
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_oversized",
      source: "mock://oversized",
      blocks: [
        block(1, "项目  金额一  金额二", 1),
        block(2, longRow, 1)
      ]
    },
    { ...TABLE_OPTIONS, maxChars: 20, overlapChars: 2 }
  );

  assert.equal(result.ok, true);
  const tableChunk = result.chunks.find((chunk) => chunk.metadata.isTableChunk === true);
  assert.ok(tableChunk);
  assert.ok(tableChunk.text.length > 20);
  assert.match(tableChunk.text, /123,456,789/);
});

test("a misclassified endless table row stream is bounded into multiple table groups", () => {
  const result = chunkDocumentBlocks(
    {
      documentId: "doc_table_boundary",
      source: "mock://table-boundary",
      blocks: Array.from({ length: 12 }, (_, index) =>
        block(index + 1, `行${index + 1}  ${"1234567890  ".repeat(5)}`, 1)
      )
    },
    { ...TABLE_OPTIONS, maxChars: 20, overlapChars: 2, tableMaxChars: 100 }
  );

  assert.equal(result.ok, true);
  assert.ok(result.chunks.filter((chunk) => chunk.metadata.isTableChunk === true).length > 1);
});

test("resolveChunkerVersion derives from the effective strategy", () => {
  assert.equal(resolveChunkerVersion(TABLE_OPTIONS), "table_aware-80-10-v1");
  assert.notEqual(
    resolveChunkerVersion(TABLE_OPTIONS),
    resolveChunkerVersion({ strategy: "heading_aware", maxChars: 1200, overlapChars: 150 })
  );
});

test("retrieval expands a tableGroupId sibling before rerank and can disable expansion", async () => {
  const summary = embedded("summary_0", "公司名称：华美公司、北方磁材、天骄清美；3 行", {
    isTableSummary: true,
    tableGroupId: "table-1"
  });
  const whole = embedded("whole_1", "公司名称  注册资本\n华美公司  213,252\n北方磁材  179,994\n天骄清美  934.51", {
    isTableChunk: true,
    tableGroupId: "table-1"
  });
  const keywordStore = {
    async findCandidateChunks() {
      return [summary];
    }
  };
  const retriever = createHybridRetriever({
    embeddingClient: createDeterministicMockEmbeddingClient(),
    vectorStore: createInMemoryVectorStore(),
    keywordStore,
    tableChunks: [summary, whole]
  });

  const expanded = await retriever.retrieve("北方磁材", {
    mode: "keyword",
    topK: 5,
    candidateLimit: 5,
    rerank: false
  });
  const noExpansion = await retriever.retrieve("北方磁材", {
    mode: "keyword",
    topK: 5,
    candidateLimit: 5,
    rerank: false,
    expandTableGroups: false
  });

  assert.equal(expanded.ok, true);
  assert.equal(noExpansion.ok, true);
  assert.deepEqual(
    expanded.results.map((entry) => entry.chunk.chunkId).sort(),
    ["summary_0", "whole_1"]
  );
  assert.deepEqual(noExpansion.results.map((entry) => entry.chunk.chunkId), ["summary_0"]);
});

test("table chunk citations and synthesized answers keep the full table text", () => {
  const text = [
    "公司名称  注册资本  营业收入",
    `华美公司  213,252.00  ${"411,947.55 ".repeat(20)}`,
    "北方磁材  179,994.71  944,806.24",
    "天骄清美  934.51  6,785.01"
  ].join("\n");
  const result = {
    chunk: { ...embedded("table_0", text, { isTableChunk: true, tableGroupId: "table-1" }), chunkIndex: 0 },
    rank: 1,
    score: 0.8,
    sourceKind: "internal",
    scoreBreakdown: {
      vectorScore: 0.8,
      keywordScore: 0.7,
      hybridScore: 0.75,
      finalScore: 0.8,
      vectorWeight: 0.65,
      keywordWeight: 0.35,
      matchedTerms: ["公司", "北方磁材"],
      queryTermCoverage: 0.5,
      headingMatch: false
    }
  };

  const citation = createCitationFromRetrievedChunk(result);
  const answer = synthesizeRagAnswer("主要控股参股公司有哪些？", [result]);

  assert.equal(citation.quote, text);
  assert.match(answer.answer, /北方磁材/);
  assert.match(answer.answer, /天骄清美/);
  assert.equal(answer.citations[0].quote, text);
});

test("data source runtime expands a summary hit to its whole-table sibling", async () => {
  const runtime = createDataSourceRuntime({
    embeddingClient: createDeterministicMockEmbeddingClient(),
    chunkingOptions: {
      strategy: "table_aware",
      maxChars: 1200,
      overlapChars: 150
    }
  });
  const ingested = await runtime.ingest({
    source: "mock://table-runtime",
    fileName: "table.pdf",
    contentType: "application/pdf",
    content: buildTablePdf()
  });

  assert.equal(ingested.ok, true);
  if (!ingested.ok) return;
  const tableChunks = ingested.data.chunks.filter(
    (chunk) => chunk.metadata.isTableChunk === true || chunk.metadata.isTableSummary === true
  );
  assert.equal(tableChunks.length, 2);

  const searched = await runtime.search("North Magnet", { topK: 5, mode: "keyword" });
  assert.equal(searched.ok, true);
  if (!searched.ok) return;
  const resultIds = searched.data.results.map((result) => result.chunkId);
  assert.ok(tableChunks.every((chunk) => resultIds.includes(chunk.chunkId)));
});

/**
 * 构造带三列表行和正文的确定性 PDF，用于验证真实 PDF ingestion 的整表展开。
 *
 * @returns {Uint8Array} 最小合法 PDF 字节。
 */
function buildTablePdf() {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const pageContent = [
    "BT /F1 12 Tf 72 720 Td (Company   Capital   Revenue) Tj ET",
    "BT /F1 12 Tf 72 700 Td (Huamei   213,252.00   411,947.55) Tj ET",
    "BT /F1 12 Tf 72 680 Td (North Magnet   179,994.71   944,806.24) Tj ET",
    "BT /F1 12 Tf 72 660 Td (Tianjiao   934.51   6,785.01) Tj ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageContent, "latin1") + 1} >>\nstream\n${pageContent}\nendstream`
  ];
  let buffer = Buffer.from(header);
  const offsets = objects.map((body, index) => {
    const offset = buffer.length;
    buffer = Buffer.concat([buffer, Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]);
    return offset;
  });
  const xrefStart = buffer.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  buffer = Buffer.concat([buffer, Buffer.from(xref, "latin1")]);
  buffer = Buffer.concat([
    buffer,
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, "latin1")
  ]);
  return new Uint8Array(buffer);
}
