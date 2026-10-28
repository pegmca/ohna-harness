/**
 * Finance Golden Studio 草稿存储与原子写入契约测试。
 *
 * 覆盖批次/草稿枚举、保存读取、原子替换失败、损坏文件保留、批次统计、
 * 路径边界与备份命名唯一性。所有文件系统副作用都限制在真实临时目录内。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backupFile } from "../src/core/backups.ts";
import { listBatches, listDrafts, readDraft, saveDraft } from "../src/core/drafts.ts";
import { writeFileAtomic } from "../src/core/fs-atomic.ts";

/** 本测试文件创建的临时目录，统一在 after 钩子中清理。 */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("保存草稿后可读取，并将批次、保存时间和文件路径写入本地 _draft", async () => {
  const config = makeConfig();
  const input = makeDraft("fin-D001");

  const result = await saveDraft(config, "batch-01", "fin-D001", {
    ...input,
    _draft: {
      approved: true,
      lastValidatedAt: "2026-10-27T09:00:00.000Z",
      validation: { ok: true, errors: [], warnings: [], keywordResults: [] }
    }
  });

  const expectedPath = join(config.draftRoot, "batch-01", "fin-D001.jsonl");
  assert.equal(result.filePath, expectedPath);
  assert.equal(result.draft.id, "fin-D001");
  assert.equal(result.draft._draft.batch, "batch-01");
  assert.equal(result.draft._draft.approved, true);
  assert.equal(result.draft._draft.lastValidatedAt, "2026-10-27T09:00:00.000Z");
  assert.equal(result.draft._draft.filePath, expectedPath);
  assert.equal(Number.isNaN(Date.parse(result.draft._draft.savedAt)), false);
  assert.equal(existsSync(expectedPath), true);
  assert.equal(readFileSync(expectedPath, "utf8").endsWith("\n"), true);

  assert.deepEqual(await readDraft(config, "batch-01", "fin-D001"), result.draft);
});

test("草稿列表返回轻量摘要，批次列表统计草稿、待审核、已审核与损坏数量", async () => {
  const config = makeConfig();
  await saveDraft(config, "batch-02", "fin-D002", {
    ...makeDraft("fin-D002", "pending"),
    _draft: { approved: false }
  });
  await saveDraft(config, "batch-02", "fin-D001", {
    ...makeDraft("fin-D001", "approved"),
    _draft: { approved: true }
  });
  const corruptPath = join(config.draftRoot, "batch-02", "fin-D003.jsonl");
  writeFileSync(corruptPath, "{not-json}\n", "utf8");
  writeFileSync(join(config.draftRoot, "batch-02", "_index.json"), "{}", "utf8");
  mkdirSync(join(config.draftRoot, "batch-01"));

  const drafts = await listDrafts(config, "batch-02");
  assert.deepEqual(
    drafts.map(({ id, approved, corrupt }) => ({ id, approved, corrupt })),
    [
      { id: "fin-D001", approved: true, corrupt: false },
      { id: "fin-D002", approved: false, corrupt: false },
      { id: "fin-D003", approved: false, corrupt: true }
    ]
  );
  assert.equal(drafts[0].query, "approved");
  assert.equal(drafts[2].errorCode, "draft_corrupt");

  const batches = await listBatches(config);
  assert.deepEqual(
    batches.map(({ name, draftCount, approvedCount, pendingCount, corruptCount }) => ({
      name,
      draftCount,
      approvedCount,
      pendingCount,
      corruptCount
    })),
    [
      {
        name: "batch-01",
        draftCount: 0,
        approvedCount: 0,
        pendingCount: 0,
        corruptCount: 0
      },
      {
        name: "batch-02",
        draftCount: 3,
        approvedCount: 1,
        pendingCount: 1,
        corruptCount: 1
      }
    ]
  );
});

test("损坏的 JSONL 返回结构化错误且原文件原样保留", async () => {
  const config = makeConfig();
  const filePath = join(config.draftRoot, "batch-03", "fin-D004.jsonl");
  const corruptContent = '{"id":"fin-D004",\n';
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, corruptContent, "utf8");

  await assert.rejects(
    readDraft(config, "batch-03", "fin-D004"),
    (error) => {
      assert.equal(error.code, "draft_corrupt");
      assert.equal(error.details.filePath, filePath);
      assert.match(error.message, /JSON/);
      return true;
    }
  );
  assert.equal(readFileSync(filePath, "utf8"), corruptContent);
  assert.equal(existsSync(filePath), true);
});

test("缺失的草稿返回 structured not-found，而缺失批次目录列出为空", async () => {
  const config = makeConfig();

  assert.deepEqual(await listDrafts(config, "missing-batch"), []);
  await assert.rejects(
    readDraft(config, "missing-batch", "fin-D404"),
    hasCode("draft_not_found")
  );
});

test("草稿路径不匹配或缺少单个 JSON 对象时按损坏文件报告", async () => {
  const config = makeConfig();
  const batchDir = join(config.draftRoot, "batch-04");
  mkdirSync(batchDir, { recursive: true });
  const mismatch = join(batchDir, "fin-D005.jsonl");
  const multiple = join(batchDir, "fin-D006.jsonl");
  writeFileSync(mismatch, `${JSON.stringify(makeDraft("fin-D099"))}\n`, "utf8");
  writeFileSync(
    multiple,
    `${JSON.stringify(makeDraft("fin-D006"))}\n${JSON.stringify(makeDraft("fin-D006"))}\n`,
    "utf8"
  );

  await assert.rejects(readDraft(config, "batch-04", "fin-D005"), hasCode("draft_corrupt"));
  await assert.rejects(readDraft(config, "batch-04", "fin-D006"), hasCode("draft_corrupt"));
  assert.equal(existsSync(mismatch), true);
  assert.equal(existsSync(multiple), true);
});

test("原子替换在写入失败时保留原文件并清理临时文件", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root 用户不受目录写权限限制");
    return;
  }

  const parent = makeTempDir();
  const target = join(parent, "golden.jsonl");
  const original = '{"id":"fin-001"}\n';
  writeFileSync(target, original, "utf8");
  chmodSync(parent, 0o500);

  try {
    await assert.rejects(writeFileAtomic(target, '{"id":"fin-002"}\n'), hasCode("atomic_write_failed"));
    assert.equal(readFileSync(target, "utf8"), original);
    assert.deepEqual(readdirSync(parent), ["golden.jsonl"]);
  } finally {
    chmodSync(parent, 0o700);
  }
});

test("读取、保存与备份均拒绝逃逸工作区的路径", async () => {
  const config = makeConfig();
  const outsideRoot = makeTempDir();
  const outsideFile = join(outsideRoot, "outside.jsonl");
  writeFileSync(outsideFile, `${JSON.stringify(makeDraft("fin-D007"))}\n`, "utf8");

  await assert.rejects(readDraft(config, "../escape", "fin-D007"), hasCode("invalid_batch_name"));
  await assert.rejects(saveDraft(config, "batch-05", "../escape", makeDraft("../escape")), hasCode("invalid_draft_id"));
  await assert.rejects(backupFile(config, outsideFile, "outside"), hasCode("path_outside_root"));
  assert.equal(existsSync(join(config.workspaceRoot, "escape", "fin-D007.jsonl")), false);
});

test("同一毫秒内相同标签的备份文件名仍唯一且内容完整", async () => {
  const config = makeConfig();
  writeFileSync(config.goldenPath, '{"id":"fin-001"}\n', "utf8");

  const first = await backupFile(config, config.goldenPath, "before-promote");
  const second = await backupFile(config, config.goldenPath, "before-promote");

  assert.notEqual(first, second);
  assert.equal(dirname(first), config.backupRoot);
  assert.equal(dirname(second), config.backupRoot);
  assert.equal(readFileSync(first, "utf8"), '{"id":"fin-001"}\n');
  assert.equal(readFileSync(second, "utf8"), '{"id":"fin-001"}\n');
});

/**
 * 创建带完整 WorkspaceConfig 形状的隔离工作区。
 *
 * @returns 测试用工作区配置。
 */
function makeConfig() {
  const workspaceRoot = makeTempDir();
  const goldenRoot = join(workspaceRoot, "datasets", "finance", "rag-golden");
  const config = {
    repoRoot: workspaceRoot,
    workspaceRoot,
    corpusRoot: join(workspaceRoot, "corpus"),
    manifestPath: join(workspaceRoot, "corpus", "manifest", "manifest.jsonl"),
    draftRoot: join(goldenRoot, "_drafts"),
    goldenPath: join(goldenRoot, "golden.jsonl"),
    generatedPath: join(workspaceRoot, "datasets", "finance", "rag-golden-v1.json"),
    backupRoot: join(goldenRoot, "_backups")
  };
  mkdirSync(config.draftRoot, { recursive: true });
  mkdirSync(config.backupRoot, { recursive: true });
  writeFileSync(config.goldenPath, "", "utf8");
  return config;
}

/**
 * 构造一条完整的手工作者字段草稿。
 *
 * @param id 草稿 ID。
 * @param query 用户问题文本。
 * @returns 不含本地 `_draft` 的草稿对象。
 */
function makeDraft(id, query = "广发证券 2025Q1 股东人数是多少？") {
  return {
    id,
    query,
    type: "numeric_fact",
    difficulty: "easy",
    answer_type: "number",
    gold_answer: "合计184,679户",
    answer_unit: "户",
    evidence: [
      {
        ticker: "000776.SZ",
        report_type: "q1",
        period: "2025Q1",
        section: "股东信息",
        page: 12,
        quote: "股东总数为184,679户",
        source_kind: "table"
      }
    ],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "测试草稿",
    expected_keywords: ["184,679"]
  };
}

/**
 * 创建已 realpath 规范化的临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "finance-golden-drafts-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 构造稳定错误码断言。
 *
 * @param code 期望错误码。
 * @returns node:assert 的错误断言函数。
 */
function hasCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}
