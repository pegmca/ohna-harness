/**
 * Golden Studio promote 工作流契约测试。
 *
 * 覆盖审核草稿映射、连续 ID、作者集备份、未审核保留，以及任一审核草稿
 * 校验失败时整批零写入的全有或全无语义。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listDrafts, saveDraft } from "../src/core/drafts.ts";
import { promoteBatch } from "../src/core/promote.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  readGolden,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

after(cleanupWorkflowFixtures);

test("promoteBatch 只发布审核草稿、剔除本地状态、分配连续 ID 并备份原作者集", async () => {
  const config = await makeValidPromotionWorkspace();
  const existing = makeGoldenCase({
    id: "fin-001",
    query: "Existing query?",
    gold_answer: "Revenue 100",
    expected_keywords: ["Revenue 100"]
  });
  const original = writeGolden(config, [existing]);
  await saveDraft(config, "batch-01", "fin-D010", {
    ...makeGoldenCase({
      id: "fin-D010",
      query: "Approved query?",
      gold_answer: "Revenue 100",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: true }
  });
  await saveDraft(config, "batch-01", "fin-D011", {
    ...makeGoldenCase({
      id: "fin-D011",
      query: "Pending query?",
      gold_answer: "Revenue 100",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: false }
  });

  const report = await promoteBatch(config, "batch-01");

  assert.equal(report.ok, true);
  assert.equal(report.approvedCount, 1);
  assert.equal(report.promotedCount, 1);
  assert.equal(report.pendingCount, 1);
  assert.ok(report.backupPath);
  assert.equal(readFileSync(report.backupPath, "utf8"), original);
  const promoted = readGolden(config)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    promoted.map((record) => record.id),
    ["fin-001", "fin-002"]
  );
  assert.equal(promoted[1].query, "Approved query?");
  assert.equal(Object.hasOwn(promoted[1], "_draft"), false);
  assert.deepEqual(await listDrafts(config, "batch-01"), [
    {
      id: "fin-D010",
      query: "Approved query?",
      type: "numeric_fact",
      approved: true,
      isNegative: false,
      health: undefined,
      corrupt: false
    },
    {
      id: "fin-D011",
      query: "Pending query?",
      type: "numeric_fact",
      approved: false,
      isNegative: false,
      health: undefined,
      corrupt: false
    }
  ]);
});

test("promoteBatch 任一审核草稿校验失败时零写入且不创建备份", async () => {
  const config = await makeValidPromotionWorkspace();
  const original = writeGolden(config, [
    makeGoldenCase({ id: "fin-001", query: "Existing query?" })
  ]);
  await saveDraft(config, "batch-02", "fin-D020", {
    ...makeGoldenCase({
      id: "fin-D020",
      query: "Valid query?",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: true }
  });
  await saveDraft(config, "batch-02", "fin-D021", {
    ...makeGoldenCase({
      id: "fin-D021",
      query: "Invalid period?",
      expected_keywords: ["Revenue 100"],
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
    }),
    _draft: { approved: true }
  });

  const report = await promoteBatch(config, "batch-02");

  assert.equal(report.ok, false);
  assert.equal(report.promotedCount, 0);
  assert.equal(report.backupPath, undefined);
  assert.ok(
    report.validation.errors.some(
      (issue) =>
        issue.id === "fin-003" &&
        issue.code === "evidence_not_in_manifest" &&
        issue.field === "evidence[0]"
    ),
    JSON.stringify(report.validation.errors)
  );
  assert.equal(readGolden(config), original);
  assert.equal(existsSync(config.backupRoot), false);
});

test("promoteBatch 原子写入失败时保留原 golden 与完整备份", async () => {
  const config = await makeValidPromotionWorkspace();
  const original = writeGolden(config, [
    makeGoldenCase({ id: "fin-001", query: "Existing query?" })
  ]);
  await saveDraft(config, "batch-write-fail", "fin-D030", {
    ...makeGoldenCase({
      id: "fin-D030",
      query: "Approved query?",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: true }
  });
  await assert.rejects(
    () =>
      promoteBatch(config, "batch-write-fail", {
        writeGolden: async () => {
          const error = new Error("simulated atomic write failure");
          error.code = "EIO";
          throw error;
        }
      }),
    (error) => {
      assert.equal(error.code, "EIO");
      return true;
    }
  );
  assert.equal(readGolden(config), original);
  const backups = readdirSync(config.backupRoot);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(config.backupRoot, backups[0]), "utf8"), original);
});

test("promoteBatch 批次含损坏草稿时失败且不改写 golden", async () => {
  const config = await makeValidPromotionWorkspace();
  const original = writeGolden(config, [
    makeGoldenCase({ id: "fin-001", query: "Existing query?" })
  ]);
  const batchDir = join(config.draftRoot, "batch-corrupt");
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(join(batchDir, "fin-D040.jsonl"), "{not-json}\n", "utf8");

  await assert.rejects(
    () => promoteBatch(config, "batch-corrupt"),
    (error) => {
      assert.equal(error.code, "draft_corrupt");
      return true;
    }
  );
  assert.equal(readGolden(config), original);
  assert.equal(existsSync(config.backupRoot), false);
});

test("promoteBatch 现存 golden 非法时失败且不创建备份", async () => {
  const config = await makeValidPromotionWorkspace();
  mkdirSync(join(config.draftRoot, "batch-valid"), { recursive: true });
  const malformed = "{not-json}\n";
  mkdirSync(dirname(config.goldenPath), { recursive: true });
  writeFileSync(config.goldenPath, malformed, "utf8");

  await assert.rejects(
    () => promoteBatch(config, "batch-valid"),
    (error) => {
      assert.equal(error.code, "draft_corrupt");
      return true;
    }
  );
  assert.equal(readFileSync(config.goldenPath, "utf8"), malformed);
  assert.equal(existsSync(config.backupRoot), false);
});

test("promoteBatch 校验完整最终作者集，非法既有记录阻止备份与写入", async () => {
  const config = await makeValidPromotionWorkspace();
  const invalidExisting = {
    ...makeGoldenCase({ id: "fin-001", query: "Existing query?" }),
    query: ""
  };
  const original = writeGolden(config, [invalidExisting]);
  await saveDraft(config, "batch-final-invalid", "fin-D050", {
    ...makeGoldenCase({
      id: "fin-D050",
      query: "Approved query?",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: true }
  });

  const report = await promoteBatch(config, "batch-final-invalid");

  assert.equal(report.ok, false);
  assert.equal(report.promotedCount, 0);
  assert.ok(
    report.validation.errors.some(
      (issue) => issue.id === "fin-001" && issue.field === "query"
    ),
    JSON.stringify(report.validation.errors)
  );
  assert.equal(readGolden(config), original);
  assert.equal(existsSync(config.backupRoot), false);
});

test("promoteBatch 校验完整最终作者集，既有 ID 冲突阻止备份与写入", async () => {
  const config = await makeValidPromotionWorkspace();
  const original = writeGolden(config, [
    makeGoldenCase({ id: "fin-001", query: "First query?" }),
    makeGoldenCase({ id: "fin-001", query: "Duplicate query?" })
  ]);
  await saveDraft(config, "batch-final-duplicate", "fin-D060", {
    ...makeGoldenCase({
      id: "fin-D060",
      query: "Approved query?",
      expected_keywords: ["Revenue 100"]
    }),
    _draft: { approved: true }
  });

  const report = await promoteBatch(config, "batch-final-duplicate");

  assert.equal(report.ok, false);
  assert.equal(report.promotedCount, 0);
  assert.ok(
    report.validation.errors.some(
      (issue) => issue.code === "golden_id_duplicate" && issue.id === "fin-001"
    ),
    JSON.stringify(report.validation.errors)
  );
  assert.equal(readGolden(config), original);
  assert.equal(existsSync(config.backupRoot), false);
});

/**
 * 创建带真实 manifest/PDF 的 promote 工作区。
 *
 * @returns {Promise<object>} WorkspaceConfig。
 */
async function makeValidPromotionWorkspace() {
  const config = makeWorkflowConfig();
  const relativePath = "raw/cn/600000.SH/2025.pdf";
  writeManifest(config, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: relativePath,
      disclosure_date: "2026-01-01"
    }
  ]);
  writePdf(config, relativePath, "Revenue 100. Financial highlights.");
  return config;
}
