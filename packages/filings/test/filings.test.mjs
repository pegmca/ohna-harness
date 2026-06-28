import assert from "node:assert/strict";
import { test } from "node:test";
import { createFilingDocument, createFilingsPackageSummary } from "../dist/index.js";

test("filings package entry exposes its boundary summary", () => {
  const summary = createFilingsPackageSummary();

  assert.equal(summary.packageName, "@aiagent/filings");
  assert.equal(summary.boundary, "filing_ingestion_and_raw_text");
  assert.deepEqual(summary.supportedSourceKinds, ["local_file", "remote_url", "mock_text"]);
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
