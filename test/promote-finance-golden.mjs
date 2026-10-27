/**
 * 金融财报 RAG 黄金评测集 · 草稿定稿入册器。
 *
 * 作用：把 `mine-finance-golden.mjs` 产出的 `_drafts/<batch>/*.jsonl` 草稿（已人工补完真值）
 * 合入作者集 `datasets/finance/rag-golden/golden.jsonl`。
 *
 * 入册规则：
 * - 只读人工标记 `_draft.approved === true` 的草稿（未审核不并入，防半成品泄漏）。
 * - 重排 id 为全局递增 `fin-XXX`（基于现有 golden 最大号 + 顺序），避免与已有冲突。
 * - 剔除 `_draft` / `_draft.approved` 等内部字段，保持作者集干净。
 * - 重新写整个 golden.jsonl（先去空行、再按 id 排序），保证无空行、连续。
 * - 不改写任何已有 fin-XXX 条目（只追加）。
 *
 * 用法：
 *   node test/promote-finance-golden.mjs <batch>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const GOLDEN = resolve(REPO_ROOT, "datasets/finance/rag-golden/golden.jsonl");
const DRAFT_DIR = resolve(REPO_ROOT, "datasets/finance/rag-golden/_drafts");

/** 解析现有 golden，返回 { records, maxNum }，跳过空行。 */
function loadGolden(path) {
  if (!existsSync(path)) return { records: [], maxNum: 0 };
  const records = [];
  let maxNum = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    records.push(o);
    const m = /^fin-(\d+)$/.exec(o.id ?? "");
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  return { records, maxNum };
}

/** 把一条草稿洗成作者集条目（去掉内部字段，校验必填）。 */
function toGolden(draft) {
  const out = { ...draft };
  delete out._draft;
  delete out._approved;
  // 必填兜底：未填的字段给占位，让 validate 报错而不是静默入册。
  out.id = out.id; // 入册时由调用方重排
  if (!out.query || out.query.startsWith("（待填")) throw new Error(`${draft.id}: query 未填写`);
  if (!out.gold_answer) throw new Error(`${draft.id}: gold_answer 未填写`);
  if (!Array.isArray(out.evidence) || out.evidence.length === 0) throw new Error(`${draft.id}: evidence 为空`);
  for (const e of out.evidence) {
    if (!e.section || e.section.includes("（待补") || e.section.includes("（候选")) {
      throw new Error(`${draft.id}: evidence.section 仍待补（${e.section}）`);
    }
  }
  return out;
}

function main() {
  const batch = process.argv[2];
  if (!batch) {
    console.error("用法：node test/promote-finance-golden.mjs <batch>");
    process.exit(1);
  }
  const batchDir = resolve(DRAFT_DIR, batch);
  if (!existsSync(batchDir)) {
    console.error(`找不到草稿批次：${batchDir}`);
    process.exit(1);
  }

  const { records: existing, maxNum } = loadGolden(GOLDEN);
  const seenIds = new Set(existing.map((r) => r.id));

  let nextNum = maxNum;
  let promoted = 0;
  let pending = 0;
  for (const file of readdirSync(batchDir).sort()) {
    if (!file.endsWith(".jsonl") || file.startsWith("_")) continue;
    const raw = readFileSync(resolve(batchDir, file), "utf8").trim();
    if (!raw) continue;
    const draft = JSON.parse(raw);
    if (!draft._draft || draft._draft.approved !== true) {
      pending += 1;
      continue;
    }
    const cleaned = toGolden(draft);
    // 重排 id 为全局递增。
    nextNum += 1;
    const newId = `fin-${String(nextNum).padStart(3, "0")}`;
    cleaned.id = newId;
    // 若该草稿 id 已被占用（理论上不会，草稿用 fin-D 前缀），跳过。
    if (seenIds.has(newId)) continue;
    seenIds.add(newId);
    existing.push(cleaned);
    promoted += 1;
    console.log(`  PROMOTE ${file} → ${newId}`);
  }

  if (promoted === 0) {
    console.log(`批次 ${batch}：无已审核（_draft.approved=true）草稿可入册；待审核 ${pending} 条。`);
    process.exit(pending > 0 ? 2 : 0);
  }

  // 重新按 id 排序写出（无空行）。
  existing.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(GOLDEN, existing.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`\n入册完成：${promoted} 条新加入 golden.jsonl（共 ${existing.length} 条）；待审核 ${pending} 条未动。`);
}

main();
