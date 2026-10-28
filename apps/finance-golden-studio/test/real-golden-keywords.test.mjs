/**
 * 真实语料关键词 blocker 检查。
 *
 * FINANCE_CORPUS_ROOT 缺失时以明确原因跳过；存在时读取仓库内真实
 * golden.jsonl 和 PDF，输出稳定的逐 case/类型/evidence 失败清单。
 * 该测试只读作者集，不修正或回写任何人工 expected_keywords。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateGolden } from "../src/core/validate.ts";

/** Golden Studio 包根。 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 仓库根，用于定位 committed golden。 */
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
/** 唯一允许的 committed 作者集。 */
const GOLDEN_PATH = join(
  REPO_ROOT,
  "datasets",
  "finance",
  "rag-golden",
  "golden.jsonl"
);
/** 显式语料覆盖；不猜测开发者私有绝对路径。 */
const CORPUS_ROOT = process.env.FINANCE_CORPUS_ROOT?.trim();

test(
  "committed golden 的人工关键词在真实语料中的失败可逐项审计",
  {
    skip: CORPUS_ROOT
      ? false
      : "SKIP real-golden-keywords: FINANCE_CORPUS_ROOT is not set; real corpus was not checked."
  },
  async () => {
    assert.equal(
      existsSync(join(CORPUS_ROOT, "manifest", "manifest.jsonl")),
      true,
      `FINANCE_CORPUS_ROOT must contain manifest/manifest.jsonl: ${CORPUS_ROOT}`
    );
    const golden = readGoldenExpectations(GOLDEN_PATH);
    const report = await validateGolden({
      repoRoot: REPO_ROOT,
      workspaceRoot: REPO_ROOT,
      corpusRoot: resolve(CORPUS_ROOT),
      manifestPath: join(CORPUS_ROOT, "manifest", "manifest.jsonl"),
      draftRoot: join(
        REPO_ROOT,
        "datasets",
        "finance",
        "rag-golden",
        "_drafts"
      ),
      goldenPath: GOLDEN_PATH,
      generatedPath: join(
        REPO_ROOT,
        "datasets",
        "finance",
        "rag-golden-v1.json"
      ),
      backupRoot: join(
        REPO_ROOT,
        "datasets",
        "finance",
        "rag-golden",
        "_backups"
      )
    });
    const artifact = JSON.parse(
      readFileSync(ARTIFACT_PATH, "utf8")
    );

    assert.deepEqual(
      report.keywordResults.map(expectationKey),
      golden.flatMap((entry) =>
        entry.expected_keywords.map((keyword, keywordIndex) =>
          `${entry.id}\u0000${keywordIndex}\u0000${keyword}`
        )
      ),
      "keyword report must preserve every committed expectation in order"
    );

    const failures = report.keywordResults
      .filter((result) => !result.reachable)
      .map((result) => ({
        caseId: result.caseId,
        caseType: result.caseType,
        keywordIndex: result.keywordIndex,
        keyword: result.keyword,
        normalizedKeyword: result.normalizedKeyword,
        reason: result.reason,
        evidence: result.evidence
      }));
    const summary = report.keywordSummary;
    const exactBaseline = new Map(
      GOLDEN_EXPECTATIONS.map(([caseId, keywordIndex, keyword]) => [
        `${caseId}\u0000${keywordIndex}`,
        keyword
      ])
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          goldenPath: GOLDEN_PATH,
          corpusRoot: resolve(CORPUS_ROOT),
          summary,
          failures
        },
        null,
        2
      )}\n`
    );

    assert.equal(summary.total, report.keywordResults.length);
    assert.equal(summary.unreachable, failures.length);
    assert.equal(
      summary.byCase.reduce(
        (count, entry) => count + (entry.unreachable > 0 ? 1 : 0),
        0
      ),
      new Set(failures.map((failure) => failure.caseId)).size
    );
    assert.ok(
      failures.every(
        (failure) =>
          failure.reason === "unreachable" &&
          failure.evidence.every((entry) => entry.reachable === false) &&
          exactBaseline.get(
            `${failure.caseId}\u0000${failure.keywordIndex}`
          ) === failure.keyword &&
          failure.evidence.length ===
            golden.find((entry) => entry.id === failure.caseId).evidence.length
      ),
      "each failure must retain its committed keyword and evidence attribution"
    );
    assert.equal(report.ok, false);
    assert.equal(artifact.generatedBy.generator, HISTORICAL_GENERATOR);
    assert.match(artifact.generatedBy.note, /stale|blocked|尚未|未完成/u);
  }
);

/** 当前 committed 评测产物的历史生成来源；该文件不随本次修复重新生成。 */
const HISTORICAL_GENERATOR = "test/generate-finance-golden-v1.mjs";
/** 当前 committed 评测产物路径。 */
const ARTIFACT_PATH = join(REPO_ROOT, "datasets", "finance", "rag-golden-v1.json");

/**
 * 2026-10-29 真实语料基线：每个三元组均按 committed golden 固定，
 * 由人工在审计 PDF 后决定修订或删除，测试不得自动改词。
 */
const GOLDEN_EXPECTATIONS = [
  ["fin-001", 0, "184,679户"],
  ["fin-001", 1, "183,350户"],
  ["fin-002", 1, "43,612,009,891.02元"],
  ["fin-002", 3, "41,905,707,385.91元"],
  ["fin-003", 0, "934.51 美元"],
  ["fin-004", 4, "角色"],
  ["fin-005", 0, "15,874,924,916.38 元"],
  ["fin-006", 0, "三域四层（产业布局）"],
  ["fin-006", 7, "向石油石化、钢铁冶金、煤炭矿山、城轨交通、电气化铁路同源拓展"],
  ["fin-007", 0, "89,231,023 千元"],
  ["fin-007", 1, "89,231,023,000 元"],
  ["fin-007", 2, "89.23"],
  ["fin-008", 1, "537,444,339.69 元"],
  ["fin-008", 6, "2,232,546.11 元"],
  ["fin-008", 10, "535,211,793.58 元"],
  ["fin-008", 19, "按组合计提坏账准备"],
  ["fin-009", 1, "1,277,081,658.18 元"],
  ["fin-009", 2, "253,023.26 元"],
  ["fin-009", 3, "1,276,828,634.92 元"],
  ["fin-009", 4, "1,313,254,079.23 元"],
  ["fin-009", 5, "700,222,895.11"],
  ["fin-009", 6, "712,692,492.71"],
  ["fin-009", 7, "139,673,872.76"],
  ["fin-009", 8, "275,760,625.66"],
  ["fin-009", 10, "账面余额_期末"],
  ["fin-009", 11, "坏账准备_期末"],
  ["fin-009", 12, "账面价值_期末"],
  ["fin-010", 1, "27,655,202,065.43 元"],
  ["fin-010", 3, "28,150,749,967.59 元"],
  ["fin-011", 13, "营业收入(元)"],
  ["fin-011", 14, "归母净利(元)"],
  ["fin-011", 15, "经营活动现金流净额(元)"],
  ["fin-014", 1, "12,384,638,268.11元"],
  ["fin-014", 4, "9,065,165,097.69元"],
  ["fin-014", 6, "6,263,513,581.37元"]
];

/**
 * 读取 committed golden 的 ID 与人工关键词。
 *
 * @param path golden.jsonl 路径。
 * @returns 非 negative 记录的 ID 与关键词。
 */
function readGoldenExpectations(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.is_negative !== true)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      evidence: entry.evidence,
      expected_keywords: entry.expected_keywords
    }));
}

/**
 * 投影一条关键词结果，独立验证其未丢失 case 或原文。
 *
 * @param result 关键词结果。
 * @returns 用于顺序比较的稳定键。
 */
function expectationKey(result) {
  return `${result.caseId}\u0000${result.keywordIndex}\u0000${result.keyword}`;
}
