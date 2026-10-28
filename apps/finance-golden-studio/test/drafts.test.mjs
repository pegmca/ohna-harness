/**
 * Finance Golden Studio 草稿存储与原子写入契约测试。
 *
 * 覆盖批次/草稿枚举、保存读取、原子替换失败、损坏文件保留、批次统计、
 * 路径边界与备份命名唯一性。所有文件系统副作用都限制在真实临时目录内。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import defaultFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

test("首次保存可在 draftRoot 尚不存在时创建批次目录", async () => {
  const config = makeConfig();
  rmSync(config.draftRoot, { recursive: true, force: true });

  await saveDraft(config, "first-batch", "fin-D000", {
    ...makeDraft("fin-D000"),
    _draft: {}
  });

  assert.equal(
    existsSync(join(config.draftRoot, "first-batch", "fin-D000.jsonl")),
    true
  );
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

test("缺少本地 _draft 状态的 JSON 对象按损坏草稿报告", async () => {
  const config = makeConfig();
  const filePath = join(config.draftRoot, "batch-04b", "fin-D008.jsonl");
  const { _draft: ignored, ...withoutState } = makeDraft("fin-D008");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(withoutState)}\n`, "utf8");

  assert.equal(ignored, undefined);
  await assert.rejects(readDraft(config, "batch-04b", "fin-D008"), hasCode("draft_corrupt"));
  assert.equal(existsSync(filePath), true);
});

test("运行期形状无效的草稿返回 structured 错误且原文件保持不变", async () => {
  const config = makeConfig();
  const filePath = join(config.draftRoot, "batch-shape", "fin-D009.jsonl");
  const invalid = {
    ...makeDraft("fin-D009"),
    query: 42,
    evidence: "not-an-array",
    _draft: {}
  };
  const original = `${JSON.stringify(invalid)}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, original, "utf8");

  await assert.rejects(
    readDraft(config, "batch-shape", "fin-D009"),
    (error) => {
      assert.equal(error.code, "draft_corrupt");
      assert.match(error.message, /shape|field/i);
      return true;
    }
  );
  assert.equal(readFileSync(filePath, "utf8"), original);
  assert.equal(existsSync(filePath), true);
});

test("原子替换在 rename 失败时保留原文件并清理临时文件", async () => {
  const parent = makeTempDir();
  const target = join(parent, "golden.jsonl");
  const original = '{"id":"fin-001"}\n';
  writeFileSync(target, original, "utf8");
  let temporaryPath;
  let renamed = false;
  const fs = createAtomicFs({
    onOpen(path) {
      temporaryPath = path;
    },
    async rename() {
      renamed = true;
      const error = new Error("simulated rename failure");
      error.code = "EIO";
      throw error;
    }
  });

  await assert.rejects(
    writeFileAtomic(target, '{"id":"fin-002"}\n', fs),
    hasCode("atomic_write_failed")
  );
  assert.equal(renamed, true);
  assert.equal(typeof temporaryPath, "string");
  assert.equal(existsSync(temporaryPath), false);
  assert.equal(readFileSync(target, "utf8"), original);
  assert.deepEqual(readdirSync(parent), ["golden.jsonl"]);
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

test("首次备份可在 backupRoot 尚不存在时创建目录", async () => {
  const config = makeConfig();
  rmSync(config.backupRoot, { recursive: true, force: true });

  const backupPath = await backupFile(config, config.goldenPath, "first-backup");

  assert.equal(dirname(backupPath), config.backupRoot);
  assert.equal(existsSync(backupPath), true);
});

test("备份在 rename 失败时清理隐藏临时文件且不留下最终文件", async () => {
  const config = makeConfig();
  const original = '{"id":"fin-001"}\n';
  writeFileSync(config.goldenPath, original, "utf8");
  let temporaryPath;
  const fs = createBackupFs({
    onOpen(path) {
      temporaryPath = path;
    },
    async rename() {
      const error = new Error("simulated backup rename failure");
      error.code = "EIO";
      throw error;
    }
  });

  await assert.rejects(
    backupFile(config, config.goldenPath, "before-promote", fs),
    hasCode("backup_failed")
  );
  assert.equal(typeof temporaryPath, "string");
  assert.equal(existsSync(temporaryPath), false);
  assert.deepEqual(readdirSync(config.backupRoot), []);
});

test("备份通过隐藏临时文件写入后原子 rename 为最终文件", async () => {
  const config = makeConfig();
  const original = '{"id":"fin-001"}\n';
  writeFileSync(config.goldenPath, original, "utf8");
  const events = [];
  let temporaryPath;
  const fs = createBackupFs({
    onOpen(path) {
      temporaryPath = path;
      events.push("open");
    },
    async onWrite(path) {
      assert.equal(path, temporaryPath);
      events.push("write");
    },
    async rename(source, destination) {
      events.push("rename");
      assert.equal(source, temporaryPath);
      assert.equal(readFileSync(source, "utf8"), original);
      await defaultFs.rename(source, destination);
    }
  });

  const backupPath = await backupFile(config, config.goldenPath, "before-promote", fs);

  assert.deepEqual(events, ["open", "write", "rename"]);
  assert.equal(readFileSync(backupPath, "utf8"), original);
  assert.deepEqual(readdirSync(config.backupRoot), [basename(backupPath)]);
});

test("草稿目录创建失败映射为 atomic_write_failed", async () => {
  const config = makeConfig();
  rmSync(config.draftRoot, { recursive: true, force: true });
  writeFileSync(config.draftRoot, "not-a-directory", "utf8");

  await assert.rejects(
    saveDraft(config, "batch-dir-failure", "fin-D010", {
      ...makeDraft("fin-D010"),
      _draft: {}
    }),
    hasCode("atomic_write_failed")
  );
  assert.equal(readFileSync(config.draftRoot, "utf8"), "not-a-directory");
});

test("备份目录创建失败映射为 backup_failed", async () => {
  const config = makeConfig();
  rmSync(config.backupRoot, { recursive: true, force: true });
  writeFileSync(config.backupRoot, "not-a-directory", "utf8");

  await assert.rejects(
    backupFile(config, config.goldenPath, "before-promote"),
    hasCode("backup_failed")
  );
  assert.equal(readFileSync(config.backupRoot, "utf8"), "not-a-directory");
});

test("备份源读取失败映射为 backup_failed 且不泄漏临时清理异常", async () => {
  const config = makeConfig();
  const fs = createBackupFs({
    async readFile() {
      const error = new Error("simulated source read failure");
      error.code = "EACCES";
      throw error;
    },
    async rm() {
      throw new Error("simulated cleanup failure");
    }
  });

  await assert.rejects(
    backupFile(config, config.goldenPath, "before-promote", fs),
    (error) => {
      assert.equal(error.code, "backup_failed");
      assert.equal(error.cause.code, "EACCES");
      return true;
    }
  );
  assert.deepEqual(readdirSync(config.backupRoot), []);
});

/**
 * 构造只覆盖原子写入所需操作的文件系统测试替身。
 *
 * @param overrides 对 open/rename/rm 的可选行为覆盖。
 * @returns writeFileAtomic 内部依赖形状的完整替身。
 */
function createAtomicFs(overrides = {}) {
  return {
    async open(path) {
      overrides.onOpen?.(path);
      return defaultFs.open(path, "wx", 0o600);
    },
    async rename(source, destination) {
      return defaultFs.rename(source, destination);
    },
    async rm(path) {
      return defaultFs.rm(path);
    },
    ...overrides
  };
}

/**
 * 构造只覆盖备份所需操作的文件系统测试替身。
 *
 * @param overrides 对 mkdir/open/rename/rm 的可选行为覆盖。
 * @returns backupFile 内部依赖形状的完整替身。
 */
function createBackupFs(overrides = {}) {
  return {
    async mkdir(path, options) {
      return defaultFs.mkdir(path, options);
    },
    async open(path, flags, mode) {
      overrides.onOpen?.(path);
      const handle = await defaultFs.open(path, flags, mode);
      return {
        async writeFile(content) {
          overrides.onWrite?.(path);
          return handle.writeFile(content);
        },
        async sync() {
          return handle.sync();
        },
        async close() {
          return handle.close();
        }
      };
    },
    async readFile(path, options) {
      return defaultFs.readFile(path, options);
    },
    async rename(source, destination) {
      return defaultFs.rename(source, destination);
    },
    async rm(path) {
      return defaultFs.rm(path);
    },
    ...overrides
  };
}

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
