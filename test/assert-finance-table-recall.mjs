/**
 * D3 整表召回诊断：只跑 golden 表题的 retrieval-only 链路，并输出 chunk 级行覆盖。
 *
 * 用法：node test/assert-finance-table-recall.mjs [输出 JSON 路径]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDeterministicFinanceRagRuntime } from "../apps/finance-api/dist/eval/adapter.js";
import { loadFinanceDataset } from "../apps/finance-api/dist/eval/dataset.js";
import {
  calculateTableRowCoverage
} from "../apps/finance-api/dist/eval/table-recall-diagnostic.js";

const DATASET_PATH = resolve("datasets/finance/rag-golden-v1.json");
const GOLDEN_PATH = resolve("datasets/finance/rag-golden/golden.jsonl");
const dataset = loadFinanceDataset(DATASET_PATH);
const goldens = new Map(
  readFileSync(GOLDEN_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .map((case_) => [case_.id, case_])
);

const rows = [];
for (const case_ of dataset.cases.filter((item) => goldens.get(item.id)?.type === "table")) {
  const golden = goldens.get(case_.id);
  const goldRows = (golden?.gold_answer_table?.rows ?? []).map((row) => String(row[0]));
  if (goldRows.length === 0) continue;

  const runtime = await createDeterministicFinanceRagRuntime(case_.documents);
  const search = await runtime.search(case_.query, { mode: "keyword", topK: 20 });
  if (!search.ok) {
    rows.push({
      id: case_.id,
      query: case_.query,
      error: search.error
    });
    continue;
  }

  const results = search.data.results.map((result) => ({
    chunkId: result.chunkId,
    text: result.text,
    metadata: {}
  }));
  const projected = await projectTraceMetadata(results, runtime);
  const coverage = calculateTableRowCoverage(goldRows, projected);
  const hitTypes = projected.map((result) => ({
    chunkId: result.chunkId,
    isTableChunk: result.metadata.isTableChunk === true,
    isTableSummary: result.metadata.isTableSummary === true,
    tableGroupId: result.metadata.tableGroupId ?? null
  }));
  const groups = new Set(hitTypes.map((hit) => hit.tableGroupId).filter((id) => typeof id === "string"));

  rows.push({
    id: case_.id,
    query: case_.query,
    retrievedChunks: projected.length,
    singleChunkComplete: coverage.singleChunkComplete,
    groupComplete: coverage.groupComplete,
    tableRowCoverage: Number(coverage.coverage.toFixed(3)),
    missingRows: coverage.missingRows,
    matchedRows: coverage.matchedRows,
    matchedGroups: coverage.matchedGroups,
    hitTypes,
    siblingExpanded: hitTypes.some((hit) => hit.isTableSummary) && hitTypes.some((hit) => hit.isTableChunk),
    tableGroups: groups.size
  });
}

console.log(`table cases: ${rows.length}`);
for (const row of rows) {
  console.log(
    `${row.id}: coverage=${row.tableRowCoverage ?? "n/a"} single=${row.singleChunkComplete ?? false} ` +
      `group=${row.groupComplete ?? false} expanded=${row.siblingExpanded ?? false} missing=${(row.missingRows ?? []).join("|")}`
  );
}

if (process.argv[2]) {
  const outputPath = resolve(process.argv[2]);
  writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), "utf8");
  console.log(`wrote ${outputPath}`);
}

/**
 * 把 runtime 中同 chunkId 的元数据补回检索结果。
 *
 * @param results 检索结果最小投影。
 * @param runtime 已 ingest 的 runtime。
 * @returns 带完整 metadata 的检索结果。
 */
async function projectTraceMetadata(results, runtime) {
  const chunks = [];
  let cursor;
  do {
    const page = await runtime.listChunks({ limit: 100, ...(cursor ? { cursor } : {}) });
    chunks.push(...page.chunks);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));

  return results.map((result) => ({
    ...result,
    metadata: byId.get(result.chunkId)?.metadata ?? result.metadata
  }));
}

