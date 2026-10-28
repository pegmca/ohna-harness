/**
 * Golden Studio generate 工作流契约测试。
 *
 * 用真实 PDF 字节验证 base64 信封、精确 evidence 三元组、人工关键词传播，
 * 并确认来源缺失时整次生成失败且不留下部分产物。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
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
  assert.deepEqual(generated.expectedSources, [exactPath]);
  assert.deepEqual(generated.expectedKeywords, ["HUMAN-KEYWORD"]);
  assert.deepEqual(generated.documents.map((document) => document.source), [
    exactPath
  ]);
  assert.equal(generated.documents[0].fileName, exactPath);
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

test("generateEvalDataset 同三元组无选择器时校验失败并列出候选 file_path", async () => {
  const config = makeWorkflowConfig();
  const aPath = "raw/cn/600011.SH/annual-2024-a.pdf";
  const hPath = "raw/cn/600011.SH/annual-2024-h.pdf";
  writeManifest(config, [
    manifestRecord("600011.SH", "annual", "2024", aPath),
    manifestRecord("600011.SH", "annual", "2024", hPath)
  ]);
  writePdf(config, aPath, "HUMAN-KEYWORD A. ".repeat(8));
  writePdf(config, hPath, "HUMAN-KEYWORD H. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      evidence: [
        {
          ticker: "600011.SH",
          report_type: "annual",
          period: "2024",
          section: "Financial highlights",
          page: 1,
          quote: "Revenue 100",
          source_kind: "table"
        }
      ],
      expected_keywords: ["HUMAN-KEYWORD"]
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, false);
  assert.equal(report.caseCount, 0);
  const issue_ = report.validation.errors.find(
    (candidate) => candidate.code === "evidence_source_ambiguous"
  );
  assert.equal(issue_?.id, "fin-001");
  assert.equal(issue_?.field, "evidence[0].document_file_path");
  assert.match(issue_?.message ?? "", new RegExp(aPath));
  assert.match(issue_?.message ?? "", new RegExp(hPath));
  assert.match(issue_?.message ?? "", /document_file_path/u);
  assert.equal(existsSync(config.generatedPath), false);
});

test("generateEvalDataset document_file_path 显式选择同三元组 A 或 H 文件", async () => {
  const config = makeWorkflowConfig();
  const aPath = "raw/cn/600011.SH/annual-2024-a.pdf";
  const hPath = "raw/cn/600011.SH/annual-2024-h.pdf";
  writeManifest(config, [
    manifestRecord("600011.SH", "annual", "2024", aPath),
    manifestRecord("600011.SH", "annual", "2024", hPath)
  ]);
  const hBytes = writePdf(config, hPath, "Revenue 200. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, aPath, "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      evidence: [
        {
          ticker: "600011.SH",
          report_type: "annual",
          period: "2024",
          document_file_path: hPath,
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
  const generated = report.dataset.cases[0];
  assert.deepEqual(generated.expectedSources, [hPath]);
  assert.equal(generated.documents[0].fileName, hPath);
  assert.deepEqual(
    Buffer.from(generated.documents[0].content.contentBase64, "base64"),
    hBytes
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

test("generateEvalDataset 校验失败时保留既有生成物字节且标记 blocked", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", "raw/cn/600000.SH/2025.pdf")
  ]);
  writePdf(
    config,
    "raw/cn/600000.SH/2025.pdf",
    "Revenue 100. Only one authored anchor is present. ".repeat(8)
  );
  writeGolden(config, [
    makeGoldenCase({
      expected_keywords: ["HUMAN-KEYWORD"],
      id: "fin-001",
      type: "numeric_fact"
    })
  ]);
  mkdirSync(dirname(config.generatedPath), { recursive: true });
  const original = '{"datasetVersion":"old","cases":[{"id":"old"}]}\n';
  writeFileSync(config.generatedPath, original, "utf8");

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, false);
  assert.equal(report.artifactStatus, "blocked");
  assert.equal(report.outputPath, undefined);
  assert.equal(readFileSync(config.generatedPath, "utf8"), original);
  assert.equal(report.validation.keywordSummary.unreachable, 1);
  assert.equal(report.validation.keywordResults[0].caseId, "fin-001");
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
    "raw/b.pdf"
  ]);
});

test("generateEvalDataset latest_by 不因其他报告类型更新而跨期选文件", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("600150.SH", "annual", "2025", "raw/a.pdf", "2026-04-30"),
    manifestRecord(
      "600150.SH",
      "interim",
      "2026H1",
      "raw/b.pdf",
      "2026-08-31"
    )
  ]);
  writePdf(config, "raw/a.pdf", "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, "raw/b.pdf", "Revenue 200. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      snapshot_dependent: true,
      resolution: latestByResolution("600150.SH", "annual/2025"),
      evidence: [
        {
          ticker: "600150.SH",
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

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, true);
  assert.deepEqual(report.dataset.cases[0].expectedSources, ["raw/a.pdf"]);
});

test("generateEvalDataset latest_by 跨变体披露日并列时 resolution.variant 选择指定变体", async () => {
  const config = makeWorkflowConfig();
  const aPath = "raw/cn/600011.SH/interim-2026H1-a.pdf";
  const hPath = "raw/cn/600011.SH/interim-2026H1-h.pdf";
  writeManifest(config, [
    manifestRecord(
      "600011.SH",
      "interim",
      "2026H1",
      aPath,
      "2026-08-27",
      "a"
    ),
    manifestRecord(
      "600011.SH",
      "interim",
      "2026H1",
      hPath,
      "2026-08-27",
      "h"
    )
  ]);
  const hBytes = writePdf(
    config,
    hPath,
    "Revenue 200. HUMAN-KEYWORD. ".repeat(8)
  );
  writePdf(config, aPath, "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      snapshot_dependent: true,
      resolution: latestByResolution("600011.SH", "interim/2026H1", "h"),
      evidence: [
        {
          ticker: "600011.SH",
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
  const generated = report.dataset.cases[0];
  assert.deepEqual(generated.expectedSources, [hPath]);
  assert.deepEqual(
    Buffer.from(generated.documents[0].content.contentBase64, "base64"),
    hBytes
  );
});

test("generateEvalDataset latest_by 同语义跨变体并列时校验返回结构化歧义", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord(
      "600011.SH",
      "annual",
      "2024",
      "raw/a.pdf",
      "2026-01-01",
      "a"
    ),
    manifestRecord(
      "600011.SH",
      "annual",
      "2024",
      "raw/h.pdf",
      "2026-01-01",
      "h"
    )
  ]);
  writePdf(config, "raw/a.pdf", "Revenue 100. HUMAN-KEYWORD. ".repeat(8));
  writePdf(config, "raw/h.pdf", "Revenue 200. HUMAN-KEYWORD. ".repeat(8));
  writeGolden(config, [
    makeGoldenCase({
      snapshot_dependent: true,
      resolution: latestByResolution("600011.SH", "annual/2024"),
      evidence: [
        {
          ticker: "600011.SH",
          report_type: "annual",
          period: "2024",
          section: "Financial highlights",
          page: 1,
          quote: "Revenue 100",
          source_kind: "table"
        }
      ],
      expected_keywords: ["HUMAN-KEYWORD"]
    })
  ]);

  const report = await generateEvalDataset(config);

  assert.equal(report.ok, false);
  assert.equal(report.caseCount, 0);
  const issue_ = report.validation.errors.find(
    (candidate) => candidate.code === "latest_by_ambiguous"
  );
  assert.equal(issue_?.id, "fin-001");
  assert.equal(issue_?.field, "resolution.variant");
  assert.match(issue_?.message ?? "", /raw\/a\.pdf/u);
  assert.match(issue_?.message ?? "", /raw\/h\.pdf/u);
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
 * @param {string} [variant] 可选显式变体类。
 * @returns {object} manifest 记录。
 */
function manifestRecord(ticker, reportType, period, filePath, disclosureDate, variant) {
  return {
    ticker,
    report_type: reportType,
    period,
    file_path: filePath,
    disclosure_date: disclosureDate,
    ...(variant ? { variant } : {})
  };
}

/**
 * 构造显式 latest_by 规则。
 *
 * @param {string} ticker 股票代码。
 * @param {string} expectedReport 期望报告类型/期。
 * @param {string} [variant] 可选显式变体类。
 * @returns {object} resolution。
 */
function latestByResolution(ticker, expectedReport, variant) {
  return {
    type: "latest_by",
    field: "disclosure_date",
    scope: `ticker=${ticker}`,
    expected_report: expectedReport,
    ...(variant ? { variant } : {})
  };
}
