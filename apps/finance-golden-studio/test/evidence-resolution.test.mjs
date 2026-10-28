/**
 * Finance Golden Studio 来源身份解析契约测试。
 *
 * 覆盖同三元组 A/H 变体、file_path 唯一身份、显式 document_file_path
 * 选择器与 latest_by 跨变体歧义，不把行顺序当作消歧依据。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readManifest } from "../src/core/manifest.ts";
import {
  createManifestIndex,
  resolveEvidenceRecord,
  resolveLatestManifestRecord
} from "../src/core/evidence-resolution.ts";
import {
  cleanupWorkflowFixtures,
  makeWorkflowConfig,
  writeManifest
} from "./workflow-fixtures.mjs";

after(cleanupWorkflowFixtures);

test("readManifest 接受语义不同但三元组相同的 A/H 文档", async () => {
  const config = makeWorkflowConfig();
  const aPath = "raw/cn/600011.SH/2025-03-26_annual_600011.SH_2024.pdf";
  const hPath = "raw/cn/600011.SH/2025-04-17_annual_600011.SH_2024.pdf";
  writeManifest(config, [
    {
      ticker: "600011.SH",
      report_type: "annual",
      period: "2024",
      file_path: aPath,
      disclosure_date: "2025-03-26",
      title: "华能国际2024年年度报告全文"
    },
    {
      ticker: "600011.SH",
      report_type: "annual",
      period: "2024",
      file_path: hPath,
      disclosure_date: "2025-04-17",
      title: "华能国际H股2024年度报告"
    }
  ]);

  const result = await readManifest(config);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.records.map((record) => record.file_path),
    [aPath, hPath]
  );
});

test("readManifest 拒绝重复 file_path 身份", async () => {
  const config = makeWorkflowConfig();
  const record = {
    ticker: "600011.SH",
    report_type: "annual",
    period: "2024",
    file_path: "raw/cn/600011.SH/annual-2024.pdf"
  };
  writeManifest(config, [record, record]);

  const result = await readManifest(config);

  assert.deepEqual(
    result.errors.map((issue) => issue.code),
    ["manifest_file_path_duplicate"]
  );
});

test("无文档选择器的证据在三元组唯一时保持兼容解析", () => {
  const records = [
    manifestRecord("600000.SH", "annual", "2025", "raw/a.pdf")
  ];
  const index = createManifestIndex(records);

  const result = resolveEvidenceRecord(
    evidence("600000.SH", "annual", "2025"),
    index
  );

  assert.equal(result.kind, "resolved");
  assert.equal(result.record.file_path, "raw/a.pdf");
});

test("同三元组多记录且无选择器时返回结构化歧义与候选 file_path", () => {
  const records = [
    manifestRecord("600011.SH", "annual", "2024", "raw/a.pdf"),
    manifestRecord("600011.SH", "annual", "2024", "raw/h.pdf")
  ];
  const index = createManifestIndex(records);

  const result = resolveEvidenceRecord(
    evidence("600011.SH", "annual", "2024"),
    index
  );

  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.candidateFilePaths, ["raw/a.pdf", "raw/h.pdf"]);
  assert.equal(result.disambiguationField, "document_file_path");
});

test("document_file_path 显式选择同三元组中的 A 或 H 变体", () => {
  const records = [
    manifestRecord("600011.SH", "annual", "2024", "raw/a.pdf"),
    manifestRecord("600011.SH", "annual", "2024", "raw/h.pdf")
  ];
  const index = createManifestIndex(records);

  const result = resolveEvidenceRecord(
    evidence("600011.SH", "annual", "2024", "raw/h.pdf"),
    index
  );

  assert.equal(result.kind, "resolved");
  assert.equal(result.record.file_path, "raw/h.pdf");
});

test("latest_by 跨变体披露日并列时返回结构化歧义而非行顺序", () => {
  const records = [
    manifestRecord("600011.SH", "annual", "2024", "raw/a.pdf", "2026-01-01"),
    manifestRecord("600011.SH", "annual", "2024", "raw/h.pdf", "2026-01-01")
  ];
  const index = createManifestIndex(records);

  const result = resolveLatestManifestRecord(index, "600011.SH");

  assert.equal(result.kind, "ambiguous");
  assert.equal(result.disclosureDate, "2026-01-01");
  assert.deepEqual(result.candidateFilePaths, ["raw/a.pdf", "raw/h.pdf"]);
});

test("latest_by 只比较同 ticker 同报告类型同报告期的披露日期", () => {
  const records = [
    manifestRecord(
      "600150.SH",
      "annual",
      "2025",
      "raw/annual-2025.pdf",
      "2026-04-30"
    ),
    manifestRecord(
      "600150.SH",
      "interim",
      "2026H1",
      "raw/interim-2026H1.pdf",
      "2026-08-31"
    )
  ];
  const index = createManifestIndex(records);

  const result = resolveLatestManifestRecord(index, {
    ticker: "600150.SH",
    report_type: "annual",
    period: "2025"
  });

  assert.equal(result.kind, "resolved");
  assert.equal(result.record.file_path, "raw/annual-2025.pdf");
});

test("latest_by variant 显式选择跨 A/H 变体的最新披露日", () => {
  const records = [
    manifestRecord(
      "600011.SH",
      "annual",
      "2024",
      "raw/a.pdf",
      "2025-03-26",
      "a"
    ),
    manifestRecord(
      "600011.SH",
      "annual",
      "2024",
      "raw/h.pdf",
      "2025-04-17",
      "h"
    )
  ];
  const index = createManifestIndex(records);

  const result = resolveLatestManifestRecord(index, "600011.SH", "a");

  assert.equal(result.kind, "resolved");
  assert.equal(result.record.file_path, "raw/a.pdf");
});

/**
 * 构造 manifest 记录。
 *
 * @param {string} ticker 股票代码。
 * @param {string} reportType 报告类型。
 * @param {string} period 报告期。
 * @param {string} filePath 语料相对路径。
 * @param {string} [disclosureDate] 披露日期。
 * @param {string} [variant] 可选变体类。
 * @returns {object} manifest 记录。
 */
function manifestRecord(
  ticker,
  reportType,
  period,
  filePath,
  disclosureDate,
  variant
) {
  return {
    ticker,
    report_type: reportType,
    period,
    file_path: filePath,
    ...(disclosureDate ? { disclosure_date: disclosureDate } : {}),
    ...(variant ? { variant } : {})
  };
}

/**
 * 构造 evidence 引用。
 *
 * @param {string} ticker 股票代码。
 * @param {string} reportType 报告类型。
 * @param {string} period 报告期。
 * @param {string} [filePath] 可选文档选择器。
 * @returns {object} evidence 引用。
 */
function evidence(ticker, reportType, period, filePath) {
  return {
    ticker,
    report_type: reportType,
    period,
    ...(filePath ? { document_file_path: filePath } : {})
  };
}
