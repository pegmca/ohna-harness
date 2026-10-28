/**
 * Golden Studio generate 工作流契约测试。
 *
 * 用真实 PDF 字节验证 base64 信封、精确 evidence 三元组、人工关键词传播，
 * 并确认来源缺失时整次生成失败且不留下部分产物。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { generateEvalDataset } from "../src/core/generate.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

after(cleanupWorkflowFixtures);

test("generateEvalDataset 按精确来源嵌入 PDF bytes 并原样传播人工 expected_keywords", async () => {
  const config = makeWorkflowConfig();
  const exactPath = "raw/cn/600000.SH/2025.pdf";
  const newerPath = "raw/cn/600000.SH/2026.pdf";
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", exactPath, "2026-01-01"),
    manifestRecord("600000.SH", "annual", "2026", newerPath, "2027-01-01")
  ]);
  const exactBytes = writePdf(
    config,
    exactPath,
    "Revenue 100. HUMAN-KEYWORD lives here. ".repeat(8)
  );
  writePdf(config, newerPath, "Revenue 999. HUMAN-KEYWORD lives here. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      gold_answer: "Gold prose says 100 without the marker.",
      expected_keywords: ["HUMAN-KEYWORD"]
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, true);
  assert.equal(report.outputPath, config.generatedPath);
  assert.equal(report.caseCount, 1);
  assert.equal(report.ragCount, 1);
  assert.equal(report.failureCount, 0);
  const dataset = JSON.parse(readFileSync(config.generatedPath, "utf8"));
  assert.equal(dataset.datasetVersion, "finance-rag-golden-v1.0.0");
  assert.equal(dataset.cases.length, 1);
  const generated = dataset.cases[0];
  assert.deepEqual(generated.expectedSources, ["600000.SH/annual/2025"]);
  assert.deepEqual(generated.expectedKeywords, ["HUMAN-KEYWORD"]);
  assert.deepEqual(generated.documents.map((document) => document.source), [
    "600000.SH/annual/2025"
  ]);
  assert.equal(generated.documents[0].fileName, "600000.SH/annual/2025.pdf");
  assert.equal(generated.documents[0].content.contentEncoding, "base64");
  assert.deepEqual(
    Buffer.from(generated.documents[0].content.contentBase64, "base64"),
    exactBytes
  );
  assert.equal(
    generated.expectedKeywords.includes("Gold prose says 100 without the marker."),
    false
  );
});

test("generateEvalDataset 精确来源缺失时失败且不回退到同 ticker 最新文件", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord(
      "600000.SH",
      "annual",
      "2025",
      "raw/cn/600000.SH/2025.pdf",
      "2026-01-01"
    ),
    manifestRecord(
      "600000.SH",
      "annual",
      "2026",
      "raw/cn/600000.SH/2026.pdf",
      "2027-01-01"
    )
  ]);
  writePdf(
    config,
    "raw/cn/600000.SH/2025.pdf",
    "Revenue 100. HUMAN-KEYWORD. ".repeat(8)
  );
  writePdf(
    config,
    "raw/cn/600000.SH/2026.pdf",
    "Revenue 999. HUMAN-KEYWORD. ".repeat(8)
  );
  writeGolden(config, [
    makeGoldenCase({
      expected_keywords: ["HUMAN-KEYWORD"],
      evidence: [
        {
          ticker: "600000.SH",
          report_type: "annual",
          period: "2024",
          section: "Financial highlights",
          page: 1,
          quote: "Revenue 100",
          source_kind: "table"
        }
      ]
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, false);
  assert.equal(report.caseCount, 0);
  assert.ok(
    report.validation.errors.some(
      (issue) =>
        issue.id === "fin-001" &&
        issue.code === "evidence_not_in_manifest" &&
        issue.field === "evidence[0]"
    ),
    JSON.stringify(report.validation.errors)
  );
  assert.equal(existsSync(config.generatedPath), false);
});

test("generateEvalDataset 将 negative 项映射为 failure 且不伪造来源文档", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, []);
  writeGolden(config, [
    makeGoldenCase({
      id: "fin-012",
      type: "negative",
      answer_type: "text",
      gold_answer: "The corpus does not include this issuer.",
      answer_unit: "text",
      evidence: [],
      expected_keywords: undefined,
      is_negative: true,
      resolution: {
        type: "ticker_absent",
        scope: "ticker=002340.SZ",
        expected_report: "（无）"
      }
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, true);
  assert.equal(report.ragCount, 0);
  assert.equal(report.failureCount, 1);
  const generated = JSON.parse(readFileSync(config.generatedPath, "utf8")).cases[0];
  assert.equal(generated.mode, "failure");
  assert.deepEqual(generated.documents, []);
  assert.deepEqual(generated.expectedSources, []);
  assert.deepEqual(generated.expectedKeywords, []);
});

test("generateEvalDataset latest_by 唯一最大披露日时选择该唯一记录", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("000963.SZ", "annual", "2024", "raw/a.pdf", "2025-01-01"),
    manifestRecord("000963.SZ", "interim", "2026H1", "raw/b.pdf", "2026-08-27"),
    manifestRecord("000963.SZ", "annual", "2025", "raw/c.pdf", "2026-03-01")
  ]);
  writePdf(config, "raw/a.pdf", "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, "raw/b.pdf", "Revenue 200. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, "raw/c.pdf", "Revenue 300. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      snapshot_dependent: true,
      resolution: latestByResolution("000963.SZ", "interim/2026H1"),
      evidence: [
        {
          ticker: "000963.SZ",
          report_type: "interim",
          period: "2026H1",
          section: "Financial highlights",
          page: 1,
          quote: "Revenue 200",
          source_kind: "table"
        }
      ],
      expected_keywords: ["HUMAN-KEYWORD"]
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, true);
  assert.deepEqual(report.dataset.cases[0].expectedSources, [
    "000963.SZ/interim/2026H1"
  ]);
});

test("generateEvalDataset latest_by 最大披露日并列时返回结构化歧义错误", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("000963.SZ", "annual", "2025", "raw/a.pdf", "2026-08-27"),
    manifestRecord("000963.SZ", "interim", "2026H1", "raw/b.pdf", "2026-08-27")
  ]);
  writePdf(config, "raw/a.pdf", "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, "raw/b.pdf", "Revenue 200. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      snapshot_dependent: true,
      resolution: latestByResolution("000963.SZ", "annual/2025"),
      evidence: [
        {
          ticker: "000963.SZ",
          report_type: "annual",
          period: "2025",
          section: "Financial highlights",
          page: 1,
          quote: "Revenue 100",
          source_kind: "table"
        }
      ],
      expected_keywords: ["HUMAN-KEYWORD"]
    })
  ]);

  await assert.rejects(
    () => generateEvalDataset(config),
    (error) => {
      assert.equal(error.code, "evidence_parse_failed");
      assert.equal(error.details.reason, "latest_by_ambiguous");
      assert.deepEqual(error.details.disclosure_date, "2026-08-27");
      return true;
    }
  );
  assert.equal(existsSync(config.generatedPath), false);
});

/**
 * 构造 manifest 记录。
 *
 * @param {string} ticker 股票代码。
 * @param {string} reportType 报告类型。
 * @param {string} period 报告期。
 * @param {string} filePath 语料相对路径。
 * @param {string} disclosureDate 披露日期。
 * @returns {object} manifest 记录。
 */
function manifestRecord(ticker, reportType, period, filePath, disclosureDate) {
  return {
    ticker,
    report_type: reportType,
    period,
    file_path: filePath,
    disclosure_date: disclosureDate
  };
}

/**
 * 构造显式 latest_by 规则。
 *
 * @param {string} ticker 股票代码。
 * @param {string} expectedReport 期望报告类型/期。
 * @returns {object} resolution。
 */
function latestByResolution(ticker, expectedReport) {
  return {
    type: "latest_by",
    field: "disclosure_date",
    scope: `ticker=${ticker}`,
    expected_report: expectedReport
  };
}
