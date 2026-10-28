/**
 * Golden Studio mine 工作流契约测试。
 *
 * 使用真实临时 manifest/PDF 覆盖候选草稿输出、精确来源缺失与反例骨架；
 * 失败候选必须进入报告且不得写入任何草稿。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listDrafts, readDraft } from "../src/core/drafts.ts";
import { mineCandidates } from "../src/core/mine.ts";
import {
  cleanupWorkflowFixtures,
  makeWorkflowConfig,
  writeManifest,
  writeAnchoredPdf,
  writePdf
} from "./workflow-fixtures.mjs";

after(cleanupWorkflowFixtures);

test("mineCandidates 从精确来源生成可读回的健康草稿", async () => {
  const config = makeWorkflowConfig();
  const relativePath = "raw/cn/600000.SH/2025.pdf";
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", relativePath)
  ]);
  writeAnchoredPdf(config, relativePath);

  const report = await mineCandidates(config, {
    batch: "batch-mine",
    candidates: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        type: "numeric_fact"
      }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.equal(report.batch, "batch-mine");
  assert.equal(report.draftedCount, 1);
  assert.equal(report.skippedCount, 0);
  assert.equal(report.drafts.length, 1);
  const draft = report.drafts[0];
  assert.equal(draft.id, "fin-D001");
  assert.equal(draft._draft.extraction_health, "ok");
  assert.equal(draft._draft.file_path, relativePath);
  assert.deepEqual(
    await readDraft(config, "batch-mine", "fin-D001"),
    report.drafts[0]
  );
});

test("mineCandidates 缺少精确 evidence 三元组时跳过且不回退同 ticker 文件", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", "raw/cn/600000.SH/2025.pdf")
  ]);
  writePdf(
    config,
    "raw/cn/600000.SH/2025.pdf",
    "Revenue 100. ".repeat(30)
  );

  const report = await mineCandidates(config, {
    batch: "batch-missing",
    candidates: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2024",
        type: "numeric_fact"
      }
    ]
  });

  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.equal(report.draftedCount, 0);
  assert.equal(report.skippedCount, 1);
  assert.equal(report.skipped[0].reason, "evidence_not_in_manifest");
  assert.deepEqual(await listDrafts(config, "batch-missing"), []);
  assert.equal(
    existsSync(join(config.draftRoot, "batch-missing", "fin-D001.jsonl")),
    false
  );
});

test("mineCandidates 为语料确实缺席的 negative 候选生成反例骨架", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", "raw/cn/600000.SH/2025.pdf")
  ]);

  const report = await mineCandidates(config, {
    batch: "batch-negative",
    candidates: [
      {
        ticker: "002340.SZ",
        report_type: "annual",
        period: "2025",
        type: "negative"
      }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.equal(report.drafts[0].is_negative, true);
  assert.deepEqual(report.drafts[0].evidence, []);
  assert.deepEqual(report.drafts[0].resolution, {
    type: "ticker_absent",
    scope: "ticker=002340.SZ",
    expected_report: "（无）",
    note: "语料 manifest 中无该 ticker 的任何记录"
  });
  assert.equal(report.drafts[0]._draft.extraction_health, "n/a");
});

test("mineCandidates 同时写成功候选与跳过候选时明确报告部分完成", async () => {
  const config = makeWorkflowConfig();
  const relativePath = "raw/cn/600000.SH/2025.pdf";
  writeManifest(config, [
    manifestRecord("600000.SH", "annual", "2025", relativePath)
  ]);
  writeAnchoredPdf(config, relativePath);

  const report = await mineCandidates(config, {
    batch: "batch-partial",
    candidates: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        type: "numeric_fact"
      },
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2024",
        type: "numeric_fact"
      }
    ]
  });

  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.equal(report.draftedCount, 1);
  assert.equal(report.skippedCount, 1);
  assert.notEqual(await readDraft(config, "batch-partial", "fin-D001"), undefined);
});

/**
 * 构造 manifest 记录。
 *
 * @param {string} ticker 股票代码。
 * @param {string} reportType 报告类型。
 * @param {string} period 报告期。
 * @param {string} filePath 语料相对路径。
 * @returns {object} manifest 记录。
 */
function manifestRecord(ticker, reportType, period, filePath) {
  return {
    ticker,
    report_type: reportType,
    period,
    file_path: filePath,
    disclosure_date: "2026-01-01"
  };
}
