/**
 * D0 财报表格解析诊断：逐题输出表行密度、坏层标记和 gold 首列实体命中率。
 *
 * 用法：node test/diagnose-finance-table-parsing.mjs [输出 JSON 路径]
 * 语料根可通过 FINANCE_CORPUS_ROOT 覆盖；默认使用本机 origin-data 语料目录。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePdfBlocks } from "../packages/parsing/dist/index.js";

const CORPUS_ROOT = process.env.FINANCE_CORPUS_ROOT ?? "/Users/pegmca/code/origin-data/finance-data";
const MANIFEST_PATH = resolve(CORPUS_ROOT, "manifest/manifest.jsonl");
const GOLDEN_PATH = resolve("datasets/finance/rag-golden/golden.jsonl");

/**
 * 读取 JSONL 文件为对象数组。
 *
 * @param {string} path JSONL 路径。
 * @returns {Record<string, unknown>[]} 非空行解析结果。
 */
function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * 归一化文本，仅用于跨字符间距比较实体是否仍存在。
 *
 * @param {string} text 原始文本。
 * @returns {string} 去空白并小写后的文本。
 */
function normalizeForMatch(text) {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 统计文本中的 CJK 字符间空格比例。
 *
 * @param {string} text 原始文本。
 * @returns {number} 0–1 比例；无 CJK 时为 0。
 */
function cjkSpacingRatio(text) {
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const spacedPairs = (text.match(/[\u4e00-\u9fff][ \t]+[\u4e00-\u9fff]/g) ?? []).length;

  return cjkChars === 0 ? 0 : spacedPairs / cjkChars;
}

/**
 * 按 ticker/report_type/period 查找 manifest 文件记录。
 *
 * @param {Record<string, unknown>[]} manifest manifest 记录。
 * @param {Record<string, unknown>} evidence golden evidence。
 * @returns {Record<string, unknown> | undefined} 匹配记录。
 */
function findManifestRecord(manifest, evidence) {
  return manifest.find(
    (record) =>
      record.ticker === evidence.ticker &&
      record.report_type === evidence.report_type &&
      record.period === evidence.period
  );
}

const manifest = readJsonl(MANIFEST_PATH);
const golden = readJsonl(GOLDEN_PATH);
const rows = [];

for (const item of golden.filter((entry) => entry.type === "table")) {
  const evidence = item.evidence?.[0];
  if (!evidence) continue;
  const record = findManifestRecord(manifest, evidence);
  if (!record || typeof record.file_path !== "string") continue;

  const bytes = new Uint8Array(readFileSync(resolve(CORPUS_ROOT, record.file_path)));
  const blocks = parsePdfBlocks(bytes);
  const text = blocks.map((block) => block.text).join("\n");
  const entities = (item.gold_answer_table?.rows ?? []).map((row) => String(row[0]));
  const normalizedText = normalizeForMatch(text);
  const hits = entities.filter((entity) => normalizedText.includes(normalizeForMatch(entity)));
  const pageCount = new Set(blocks.map((block) => block.pageNumber ?? 0)).size;

  rows.push({
    id: item.id,
    ticker: evidence.ticker,
    period: evidence.period,
    blocks: blocks.length,
    pages: pageCount,
    blocksPerPage: Number((blocks.length / Math.max(pageCount, 1)).toFixed(2)),
    tableRows: blocks.filter((block) => block.metadata?.isTableRow === true).length,
    sourceLayerCounts: blocks.reduce((counts, block) => {
      const layer = String(block.metadata?.sourceLayer ?? "none");
      counts[layer] = (counts[layer] ?? 0) + 1;
      return counts;
    }, {}),
    cjkSpacingRatio: Number(cjkSpacingRatio(text).toFixed(3)),
    entityHits: hits.length,
    entityTotal: entities.length,
    missingEntities: entities.filter((entity) => !normalizedText.includes(normalizeForMatch(entity)))
  });
}

console.log(`table cases: ${rows.length}`);
for (const row of rows) {
  console.log(
    `${row.id} ${row.ticker}/${row.period}: blocks=${row.blocks} pages=${row.pages} rows=${row.tableRows} ` +
      `entities=${row.entityHits}/${row.entityTotal} sourceLayer=${JSON.stringify(row.sourceLayerCounts)}`
  );
}

const outputPath = process.argv[2];
if (outputPath) {
  writeFileSync(resolve(outputPath), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), "utf8");
  console.log(`wrote ${resolve(outputPath)}`);
}
