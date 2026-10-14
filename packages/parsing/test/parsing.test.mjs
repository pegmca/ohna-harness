import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createParsingPackageSummary, detectDocumentFileType, ingestDocument, PdfParser } from "../dist/index.js";

test("parsing package entry exposes its boundary summary", () => {
  const summary = createParsingPackageSummary();

  assert.equal(summary.packageName, "@aiagent/parsing");
  assert.equal(summary.boundary, "document_parsing_and_raw_text");
  assert.deepEqual(summary.supportedSourceKinds, ["local_file", "remote_url", "mock_text"]);
  assert.deepEqual(summary.supportedFileTypes, ["markdown", "txt", "pdf"]);
});

test("markdown ingestion returns a document with heading-aware blocks", async () => {
  const content = await readFile(new URL("./fixtures/annual-report.md", import.meta.url), "utf8");
  const result = ingestDocument(
    {
      source: "local://annual-report.md",
      fileName: "annual-report.md",
      contentType: "text/markdown",
      content,
      metadata: {
        ticker: "000001.SZ",
        fiscalYear: 2024
      }
    },
    {
      idGenerator: () => "parsing_test_md",
      now: () => new Date("2026-01-02T03:04:05.000Z")
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.document.documentId, "parsing_test_md");
  assert.equal(result.document.source, "local://annual-report.md");
  assert.equal(result.document.fileName, "annual-report.md");
  assert.equal(result.document.fileType, "markdown");
  assert.equal(result.document.title, "平安银行 2024 年年度报告摘要");
  assert.equal(result.document.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(result.document.metadata.ticker, "000001.SZ");
  assert.equal(result.document.metadata.fiscalYear, 2024);

  const managementBlock = result.document.blocks.find((block) => block.text.includes("资产质量保持稳健"));

  assert.ok(managementBlock);
  assert.equal(managementBlock.heading, "管理层讨论与分析");
  assert.equal(managementBlock.lineStart, 5);
  assert.equal(managementBlock.lineEnd, 6);
  assert.equal(managementBlock.id, "parsing_test_md_block_0003");
});

test("txt ingestion returns paragraph blocks with metadata and line ranges", async () => {
  const content = await readFile(new URL("./fixtures/announcement.txt", import.meta.url), "utf8");
  const result = ingestDocument(
    {
      source: "local://announcement.txt",
      fileName: "announcement.txt",
      content,
      metadata: {
        title: "平安银行董事会公告",
        sourceProvider: "fixture"
      }
    },
    {
      idGenerator: () => "parsing_test_txt",
      now: () => new Date("2026-02-03T04:05:06.000Z")
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.document.documentId, "parsing_test_txt");
  assert.equal(result.document.fileType, "txt");
  assert.equal(result.document.title, "平安银行董事会公告");
  assert.equal(result.document.blocks.length, 3);
  assert.deepEqual(
    result.document.blocks.map((block) => [block.lineStart, block.lineEnd]),
    [
      [1, 1],
      [3, 4],
      [6, 6]
    ]
  );
  assert.match(result.document.blocks[1].text, /审慎经营/);
});

test("txt ingestion splits long paragraphs by max line count", () => {
  const result = ingestDocument(
    {
      source: "mock://long-text",
      fileName: "long.txt",
      content: "第一行\n第二行\n第三行\n第四行\n第五行"
    },
    {
      idGenerator: () => "parsing_test_long_txt",
      txtMaxLinesPerBlock: 2
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.document.blocks.map((block) => [block.lineStart, block.lineEnd]),
    [
      [1, 2],
      [3, 4],
      [5, 5]
    ]
  );
});

test("empty files return a structured ingestion error", () => {
  const result = ingestDocument({
    source: "local://empty.md",
    fileName: "empty.md",
    content: " \n\n "
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "empty_file");
  assert.equal(result.error.details.fileType, "markdown");
});

test("unknown extensions return a structured ingestion error", () => {
  const result = ingestDocument({
    source: "local://archive.bin",
    fileName: "archive.bin",
    content: "some content"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_file_type");
  assert.equal(result.error.details.fileName, "archive.bin");
});

test("pdf ingestion returns a structured error for invalid PDF bytes (parser gap closed)", () => {
  const result = ingestDocument({
    source: "local://annual-report.pdf",
    fileName: "annual-report.pdf",
    contentType: "application/pdf",
    content: new Uint8Array([37, 80, 68, 70])
  });

  // 缺口已消除：不再返回 pdf_parser_not_configured，而是走真实解析；非法 PDF 收敛为结构化 parse_failed。
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "parse_failed");
});

test("pdf ingestion rejects string content with a structured error", () => {
  const result = ingestDocument({
    source: "local://annual-report.pdf",
    fileName: "annual-report.pdf",
    contentType: "application/pdf",
    content: "%PDF-1.4 string form"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "parse_failed");
});

test("file type detection uses content type before extension", () => {
  assert.equal(detectDocumentFileType("report.txt", "text/markdown"), "markdown");
  assert.equal(detectDocumentFileType("report.unknown", "application/pdf"), "pdf");
  assert.equal(detectDocumentFileType("report.markdown"), "markdown");
  assert.equal(detectDocumentFileType("report.text"), "txt");
  assert.equal(detectDocumentFileType("report.zip"), undefined);
});

test("PdfParser accepts a valid header preceded by leading bytes (ISO 32000-1 §7.5.2)", () => {
  // 允许文件头前有最多 1024 字节前导内容（BOM 等），不应被 magic bytes 门禁短路。
  const header = "%PDF-1.4".split("").map((char) => char.charCodeAt(0));
  const content = new Uint8Array([0xef, 0xbb, 0xbf, ...header]);

  assert.equal(PdfParser.accepts({ fileName: "x.pdf", content, options: {} }), true);
});

test("PdfParser rejects bytes without a %PDF- header in the first 1024 bytes", () => {
  const content = new Uint8Array(2000); // 全 0，前 1024 字节内无 %PDF-

  assert.equal(PdfParser.accepts({ fileName: "x.pdf", content, options: {} }), false);
});
