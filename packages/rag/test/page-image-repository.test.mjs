import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createCitationFromRetrievedChunk,
  createInMemoryPageImageRepository,
  ingestPageImage,
  parsePageNumber,
  renderPdfPageToPng
} from "../dist/index.js";

test("page image repository stores PNG assets by document and page", async () => {
  const repository = createInMemoryPageImageRepository();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await repository.put({
    documentId: "document_688012",
    pageNumber: 37,
    png,
    source: "688012.SH/annual/2025.pdf"
  });
  const asset = await repository.get("document_688012", 37);

  assert.ok(asset);
  assert.deepEqual(asset.png, png);
  assert.equal(repository.createPageImageRef("document_688012", 37), "document_688012#page=37");
  assert.equal(await repository.get("document_688012", 38), null);
});

test("pdf page renderer writes a PNG for an explicitly requested page", () => {
  const fixture = readFileSync(new URL("../test/fixtures/page-image.pdf", import.meta.url));
  const png = renderPdfPageToPng({
    pdf: new Uint8Array(fixture),
    pageNumber: 1,
    dpi: 40,
    binary: process.env.PDFTOPPM_BIN
  });

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("page-image source produces an image citation with a stable page reference", () => {
  const citation = createCitationFromRetrievedChunk({
    chunk: {
      chunkId: "image_page_25",
      id: "image_page_25",
      documentId: "document_688012",
      source: "688012.SH/annual/2025.pdf",
      chunkIndex: 0,
      text: "中微公司2025年营业收入12,384,638,268.11元",
      charStart: 0,
      charEnd: 40,
      startOffset: 0,
      endOffset: 40,
      pageNumber: 25,
      metadata: { sourceLayer: "char_spaced" },
      embedding: [1, 0],
      embeddingModel: "mock"
    },
    rank: 1,
    score: 0.9,
    sourceKind: "internal",
    scoreBreakdown: {
      vectorScore: 0.9,
      keywordScore: 0.8,
      hybridScore: 0.85,
      finalScore: 0.9,
      vectorWeight: 0.65,
      keywordWeight: 0.35,
      matchedTerms: ["营业收入"],
      queryTermCoverage: 1,
      headingMatch: false
    }
  });

  assert.equal(citation.citationKind, "image");
  assert.equal(citation.pageImageRef, "document_688012#page=25");
});

test("image document ingestion renders and stores exactly the referenced page", async () => {
  const fixture = readFileSync(new URL("../test/fixtures/page-image.pdf", import.meta.url));
  const repository = createInMemoryPageImageRepository();
  const result = await ingestPageImage({
    pdf: new Uint8Array(fixture),
    source: "688012.SH/annual/2025.pdf",
    pageImageRef: "688012.SH/annual/2025.pdf#page=1",
    repository,
    dpi: 40,
    binary: process.env.PDFTOPPM_BIN
  });

  assert.equal(parsePageNumber("x.pdf#page=25"), 25);
  assert.equal(result.pageCount, 1);
  assert.ok(await repository.get(result.documentId, 1));
});
