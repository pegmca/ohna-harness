/**
 * Finance Golden Studio 批次校验 core 契约测试。
 *
 * 使用真实草稿目录与 manifest 验证 core 负责枚举、读取、逐条校验和合并报告，
 * 便于 CLI 与后续 server 复用同一编排。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

after(() => {
  cleanupWorkflowFixtures();
});

test("validateDraftBatch 枚举并校验草稿后合并报告", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: "raw/cn/600000.SH/2025.pdf"
    }
  ]);
  writePdf(config, "raw/cn/600000.SH/2025.pdf", "Revenue 100");
  const validDraft = {
    ...makeGoldenCase({ id: "fin-D001" }),
    _draft: { approved: false }
  };
  const invalidDraft = {
    ...makeGoldenCase({ id: "fin-D002", expected_keywords: [] }),
    _draft: { approved: false }
  };
  await writeDrafts(config, "batch-core", [validDraft, invalidDraft]);

  const { validateDraftBatch } = await import("../src/core/validate-batch.ts");
  const result = await validateDraftBatch(config, "batch-core");

  assert.equal(result.batch, "batch-core");
  assert.equal(result.draftCount, 2);
  assert.equal(result.validation.ok, false);
  assert.deepEqual(
    result.validation.errors.map((issue) => issue.code),
    ["expected_keywords_required"]
  );
});

test("validateDraftBatch 对空批次返回结构化 drafts_not_found", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, []);
  const { validateDraftBatch } = await import("../src/core/validate-batch.ts");

  await assert.rejects(
    validateDraftBatch(config, "missing-batch"),
    (error) => {
      assert.equal(error.code, "drafts_not_found");
      assert.deepEqual(error.details, { batch: "missing-batch" });
      return true;
    }
  );
});

test("validateDraftBatch 对损坏草稿返回结构化 draft_corrupt", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, []);
  const batchDir = join(config.draftRoot, "broken-batch");
  await mkdir(batchDir, { recursive: true });
  await writeFile(join(batchDir, "fin-D001.jsonl"), "{not-json}\n", "utf8");
  const { validateDraftBatch } = await import("../src/core/validate-batch.ts");

  await assert.rejects(
    validateDraftBatch(config, "broken-batch"),
    (error) => {
      assert.equal(error.code, "draft_corrupt");
      assert.equal(error.details.batch, "broken-batch");
      assert.equal(error.details.id, "fin-D001");
      return true;
    }
  );
});

test("validateDraftDraft 只返回当前草稿的问题", async () => {
  const config = makeWorkflowConfig();
  writeManifest(config, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: "raw/cn/600000.SH/2025.pdf"
    }
  ]);
  writePdf(config, "raw/cn/600000.SH/2025.pdf", "Revenue 100");
  const validDraft = {
    ...makeGoldenCase({ id: "fin-D001" }),
    _draft: { approved: false }
  };
  const invalidDraft = {
    ...makeGoldenCase({ id: "fin-D002", expected_keywords: [] }),
    _draft: { approved: false }
  };
  await writeDrafts(config, "scoped", [validDraft, invalidDraft]);
  const { validateDraftDraft } = await import("../src/core/validate-batch.ts");

  const validResult = await validateDraftDraft(config, "scoped", "fin-D001");
  const invalidResult = await validateDraftDraft(config, "scoped", "fin-D002");

  assert.deepEqual(validResult, {
    batch: "scoped",
    id: "fin-D001",
    validation: validResult.validation
  });
  assert.equal(validResult.validation.ok, true);
  assert.deepEqual(validResult.validation.errors, []);
  assert.equal(invalidResult.validation.ok, false);
  assert.deepEqual(
    invalidResult.validation.errors.map((issue) => issue.code),
    ["expected_keywords_required"]
  );
  assert.equal(invalidResult.batch, "scoped");
  assert.equal(invalidResult.id, "fin-D002");
});

/**
 * 将草稿写入隔离的批次目录。
 *
 * @param {object} config 工作区配置。
 * @param {string} batch 批次名。
 * @param {object[]} drafts 草稿对象。
 * @returns {Promise<void>} 写入完成。
 */
async function writeDrafts(config, batch, drafts) {
  const batchDir = join(config.draftRoot, batch);
  await mkdir(batchDir, { recursive: true });
  await Promise.all(
    drafts.map((draft) =>
      writeFile(
        join(batchDir, `${draft.id}.jsonl`),
        JSON.stringify(draft) + "\n",
        "utf8"
      )
    )
  );
}
