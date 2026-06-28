import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createFilingDocument,
  createFilingsPackageSummary,
  detectFilingFileType,
  ingestFiling
} from "../dist/index.js";

test("filings package entry exposes its boundary summary", () => {
  const summary = createFilingsPackageSummary();

  assert.equal(summary.packageName, "@aiagent/filings");
  assert.equal(summary.boundary, "filing_ingestion_and_raw_text");
  assert.deepEqual(summary.supportedSourceKinds, ["local_file", "remote_url", "mock_text"]);
  assert.deepEqual(summary.supportedFileTypes, ["markdown", "txt", "pdf"]);
});

test("filing documents keep metadata, source and raw text together", () => {
  const document = createFilingDocument({
    id: "filing_doc_001",
    title: "平安银行 2024 年年度报告",
    ticker: "000001.SZ",
    reportType: "annual_report",
    publishedAt: "2025-03-15T00:00:00.000Z",
    source: {
      kind: "mock_text",
      uri: "mock://filings/000001-2024",
      provider: "fixture"
    },
    metadata: {
      fiscalYear: 2024,
      language: "zh-CN"
    },
    rawText: "管理层讨论与分析示例文本"
  });

  assert.equal(document.id, "filing_doc_001");
  assert.equal(document.source.kind, "mock_text");
  assert.equal(document.metadata.fiscalYear, 2024);
  assert.match(document.rawText, /管理层讨论/);
});

test("markdown ingestion returns a document with heading-aware blocks", async () => {
  const content = await readFile(new URL("./fixtures/annual-report.md", import.meta.url), "utf8");
  const result = ingestFiling(
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
      idGenerator: () => "filing_test_md",
      now: () => new Date("2026-01-02T03:04:05.000Z")
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.document.documentId, "filing_test_md");
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
  assert.equal(managementBlock.id, "filing_test_md_block_0003");
});

test("txt ingestion returns paragraph blocks with metadata and line ranges", async () => {
  const content = await readFile(new URL("./fixtures/announcement.txt", import.meta.url), "utf8");
  const result = ingestFiling(
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
      idGenerator: () => "filing_test_txt",
      now: () => new Date("2026-02-03T04:05:06.000Z")
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.document.documentId, "filing_test_txt");
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
  const result = ingestFiling(
    {
      source: "mock://long-text",
      fileName: "long.txt",
      content: "第一行\n第二行\n第三行\n第四行\n第五行"
    },
    {
      idGenerator: () => "filing_test_long_txt",
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
  const result = ingestFiling({
    source: "local://empty.md",
    fileName: "empty.md",
    content: " \n\n "
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "empty_file");
  assert.equal(result.error.details.fileType, "markdown");
});

test("unknown extensions return a structured ingestion error", () => {
  const result = ingestFiling({
    source: "local://archive.bin",
    fileName: "archive.bin",
    content: "some content"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_file_type");
  assert.equal(result.error.details.fileName, "archive.bin");
});

test("pdf ingestion is explicit when parser dependency is not configured", () => {
  const result = ingestFiling({
    source: "local://annual-report.pdf",
    fileName: "annual-report.pdf",
    contentType: "application/pdf",
    content: new Uint8Array([37, 80, 68, 70])
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "pdf_parser_not_configured");
  assert.equal(result.error.details.fileName, "annual-report.pdf");
});

test("file type detection uses content type before extension", () => {
  assert.equal(detectFilingFileType("report.txt", "text/markdown"), "markdown");
  assert.equal(detectFilingFileType("report.unknown", "application/pdf"), "pdf");
  assert.equal(detectFilingFileType("report.markdown"), "markdown");
  assert.equal(detectFilingFileType("report.text"), "txt");
  assert.equal(detectFilingFileType("report.zip"), undefined);
});
