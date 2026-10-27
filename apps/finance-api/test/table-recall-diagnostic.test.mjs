import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateTableRowCoverage,
  mergeRowsByTableGroup
} from "../dist/eval/table-recall-diagnostic.js";

/**
 * 构造覆盖计算所需的检索结果最小投影。
 *
 * @param {string} chunkId chunk ID。
 * @param {string} text chunk 文本。
 * @param {Record<string, string | number | boolean | null>} metadata chunk metadata。
 * @returns {Record<string, unknown>} retrieval result 投影。
 */
function result(chunkId, text, metadata = {}) {
  return { chunkId, text, metadata };
}

test("table row coverage merges rows from chunks sharing tableGroupId", () => {
  const rows = ["华美公司", "北方磁材", "天骄清美"];
  const coverage = calculateTableRowCoverage(rows, [
    result("summary", "首列：华美公司", { isTableSummary: true, tableGroupId: "g1" }),
    result("whole", "华美公司\n北方磁材", { isTableChunk: true, tableGroupId: "g1" }),
    result("other", "无关行", { isTableChunk: true, tableGroupId: "g2" })
  ]);

  assert.equal(coverage.singleChunkComplete, false);
  assert.equal(coverage.groupComplete, false);
  assert.equal(coverage.coverage, 2 / 3);
  assert.deepEqual(coverage.missingRows, ["天骄清美"]);
  assert.deepEqual(coverage.matchedRows, ["华美公司", "北方磁材"]);
  assert.deepEqual(coverage.matchedGroups, ["g1"]);
});

test("table row coverage recognizes a single complete whole-table chunk", () => {
  const rows = ["华美公司", "北方磁材"];
  const coverage = calculateTableRowCoverage(rows, [
    result("whole", "华美公司\n北方磁材", { isTableChunk: true, tableGroupId: "g1" })
  ]);

  assert.equal(coverage.singleChunkComplete, true);
  assert.equal(coverage.groupComplete, true);
  assert.equal(coverage.coverage, 1);
  assert.deepEqual(coverage.missingRows, []);
  assert.deepEqual(coverage.matchedGroups, ["g1"]);
});

test("group merging does not merge chunks from different table groups", () => {
  const merged = mergeRowsByTableGroup(
    ["华美公司", "北方磁材"],
    [
      result("a", "华美公司", { isTableSummary: true, tableGroupId: "g1" }),
      result("b", "北方磁材", { isTableSummary: true, tableGroupId: "g2" })
    ]
  );

  assert.equal(merged.groups.length, 2);
  assert.equal(merged.groups.find((group) => group.tableGroupId === "g1")?.text.includes("华美公司"), true);
  assert.equal(merged.groups.find((group) => group.tableGroupId === "g1")?.text.includes("北方磁材"), false);
});
