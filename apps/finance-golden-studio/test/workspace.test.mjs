/**
 * Finance Golden Studio 工作区契约测试。
 *
 * 覆盖配置优先级、缺失配置、作者集路径派生以及批次/草稿 ID 的越界拒绝。
 * 所有临时目录都在真实临时目录下创建，避免 macOS `/tmp` 软链干扰作用域判断。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertContainedPath,
  resolveWorkspaceConfig,
  validateBatchName,
  validateDraftId
} from "../src/core/workspace.ts";

/** 本文件创建的临时目录，统一在 after 钩子里清理。 */
const tempDirs = [];
/** 需要恢复的环境变量快照。 */
const originalEnv = {
  FINANCE_CORPUS_ROOT: process.env.FINANCE_CORPUS_ROOT,
  GOLDEN_WORKSPACE_ROOT: process.env.GOLDEN_WORKSPACE_ROOT
};

/**
 * 创建已 realpath 规范化的临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "finance-golden-workspace-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 创建包含 manifest 的语料目录。
 *
 * @returns 语料根目录绝对路径。
 */
function makeCorpusRoot() {
  const root = makeTempDir();
  mkdirSync(join(root, "manifest"));
  writeFileSync(join(root, "manifest", "manifest.jsonl"), "");
  return root;
}

/**
 * 创建包含作者集的 golden 工作区。
 *
 * @returns golden 工作区绝对路径。
 */
function makeGoldenWorkspace() {
  const root = makeTempDir();
  mkdirSync(join(root, "datasets", "finance", "rag-golden"), { recursive: true });
  writeFileSync(join(root, "datasets", "finance", "rag-golden", "golden.jsonl"), "");
  return root;
}

/**
 * 在测试回调执行期间设置环境变量，结束后恢复。
 *
 * @param next 环境变量值。
 * @param callback 测试回调。
 * @returns 回调结果。
 */
function withEnvironment(next, callback) {
  const previous = {
    FINANCE_CORPUS_ROOT: process.env.FINANCE_CORPUS_ROOT,
    GOLDEN_WORKSPACE_ROOT: process.env.GOLDEN_WORKSPACE_ROOT
  };
  Object.assign(process.env, next);
  try {
    return callback();
  } finally {
    for (const key of ["FINANCE_CORPUS_ROOT", "GOLDEN_WORKSPACE_ROOT"]) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

after(() => {
  for (const key of ["FINANCE_CORPUS_ROOT", "GOLDEN_WORKSPACE_ROOT"]) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("环境变量提供 workspace 与 corpus 根，并派生全部数据路径", () => {
  const workspace = makeGoldenWorkspace();
  const corpus = makeCorpusRoot();

  const config = withEnvironment(
    { GOLDEN_WORKSPACE_ROOT: workspace, FINANCE_CORPUS_ROOT: corpus },
    () => resolveWorkspaceConfig()
  );

  assert.equal(config.repoRoot, resolve(new URL("../../..", import.meta.url).pathname));
  assert.equal(config.workspaceRoot, workspace);
  assert.equal(config.corpusRoot, corpus);
  assert.equal(config.manifestPath, join(corpus, "manifest", "manifest.jsonl"));
  assert.equal(config.draftRoot, join(workspace, "datasets", "finance", "rag-golden", "_drafts"));
  assert.equal(config.goldenPath, join(workspace, "datasets", "finance", "rag-golden", "golden.jsonl"));
  assert.equal(config.generatedPath, join(workspace, "datasets", "finance", "rag-golden-v1.json"));
  assert.equal(config.backupRoot, join(workspace, "datasets", "finance", "rag-golden", "_backups"));
});

test("显式参数优先于环境变量", () => {
  const envWorkspace = makeGoldenWorkspace();
  const envCorpus = makeCorpusRoot();
  const explicitWorkspace = makeGoldenWorkspace();
  const explicitCorpus = makeCorpusRoot();

  const config = withEnvironment(
    { GOLDEN_WORKSPACE_ROOT: envWorkspace, FINANCE_CORPUS_ROOT: envCorpus },
    () =>
      resolveWorkspaceConfig({
        workspaceRoot: explicitWorkspace,
        corpusRoot: explicitCorpus
      })
  );

  assert.equal(config.workspaceRoot, explicitWorkspace);
  assert.equal(config.corpusRoot, explicitCorpus);
  assert.equal(config.goldenPath, join(explicitWorkspace, "datasets", "finance", "rag-golden", "golden.jsonl"));
});

test("缺少 corpus 配置时拒绝回退到开发者私有绝对路径", () => {
  const workspace = makeGoldenWorkspace();

  assert.throws(
    () =>
      withEnvironment(
        { GOLDEN_WORKSPACE_ROOT: workspace, FINANCE_CORPUS_ROOT: undefined },
        () => {
          delete process.env.FINANCE_CORPUS_ROOT;
          return resolveWorkspaceConfig();
        }
      ),
    (error) => {
      assert.equal(error.code, "workspace_config_missing");
      assert.match(error.message, /FINANCE_CORPUS_ROOT|corpusRoot/);
      return true;
    }
  );
});

test("显式 workspace 缺少 manifest 时要求配置 corpus", () => {
  const workspace = makeGoldenWorkspace();

  assert.throws(
    () =>
      withEnvironment({ FINANCE_CORPUS_ROOT: undefined }, () => {
        delete process.env.FINANCE_CORPUS_ROOT;
        return resolveWorkspaceConfig({ workspaceRoot: workspace });
      }),
    (error) => {
      assert.equal(error.code, "workspace_config_missing");
      assert.match(error.message, /FINANCE_CORPUS_ROOT|corpusRoot/);
      return true;
    }
  );
});

test("corpus 缺少 manifest 文件时报 structured error", () => {
  const corpus = makeTempDir();
  const workspace = makeGoldenWorkspace();

  assert.throws(
    () => resolveWorkspaceConfig({ workspaceRoot: workspace, corpusRoot: corpus }),
    (error) => {
      assert.equal(error.code, "manifest_not_found");
      assert.match(error.message, /manifest\.jsonl/);
      return true;
    }
  );
});

test("assertContainedPath 拒绝 ../escape、绝对目标与软链逃逸", () => {
  const root = makeTempDir();
  mkdirSync(join(root, "inside"));
  writeFileSync(join(root, "inside", "file.txt"), "ok");

  assert.doesNotThrow(() => assertContainedPath(root, join(root, "inside", "file.txt")));
  assert.throws(() => assertContainedPath(root, "../escape"), hasCode("path_outside_root"));
  assert.throws(() => assertContainedPath(root, join(root, "..", "escape")), hasCode("path_outside_root"));
  assert.throws(() => assertContainedPath(root, join(root, "inside", "..", "..", "escape")), hasCode("path_outside_root"));

  const outside = makeTempDir();
  const link = join(root, "escape-link");
  symlinkSync(outside, link);
  assert.throws(() => assertContainedPath(root, join(link, "file.txt")), hasCode("path_outside_root"));
});

test("validateBatchName 拒绝 ../escape、绝对路径与分隔符", () => {
  const rejected = ["../escape", "/tmp/escape", "a/b", "a\\b", ".", "..", "", " ", " . "];
  for (const name of rejected) {
    assert.throws(() => validateBatchName(name), hasCode("invalid_batch_name"), name);
  }
  assert.doesNotThrow(() => validateBatchName("batch-01"));
  assert.doesNotThrow(() => validateBatchName("财务_2026"));
});

test("validateDraftId 拒绝 ../escape、绝对路径与分隔符", () => {
  const rejected = ["../escape", "/tmp/escape", "a/b", "a\\b", ".", "..", "", " ", " . "];
  for (const id of rejected) {
    assert.throws(() => validateDraftId(id), hasCode("invalid_draft_id"), id);
  }
  assert.doesNotThrow(() => validateDraftId("fin-001"));
  assert.doesNotThrow(() => validateDraftId("draft_2026-01"));
});

/**
 * 构造稳定的错误码断言。
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
