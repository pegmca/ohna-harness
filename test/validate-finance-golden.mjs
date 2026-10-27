/**
 * 金融财报 RAG 黄金评测集 · 字段校验脚本。
 *
 * 作用：逐行校验 `datasets/finance/rag-golden/golden.jsonl` 的作者集标注是否符合
 * `datasets/finance/rag-golden/SCHEMA.md` 约定，边攒题边查漏。
 *
 * 校验层级：
 * - 结构层：每行一个合法 JSON 对象、必填字段齐全、枚举/类型合法、id 唯一。
 * - 引用层：evidence 的 ticker 是否命中 manifest、report_type 枚举合法、
 *   negative 题 evidence 必空、latest_by 题须带 resolution。
 * - 答案层：table 题须给 gold_answer_table 或 gold_answer_form；快照题须带 resolution。
 *
 * 退出码：存在 error 级问题则非 0（可接 CI 门禁）；仅 warning 级为 0。
 *
 * 用法：
 *   node test/validate-finance-golden.mjs
 *   node test/validate-finance-golden.mjs <golden.jsonl> [<manifest.jsonl>]
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DEFAULT_GOLDEN = resolve(repoRoot, "datasets/finance/rag-golden/golden.jsonl");
const DEFAULT_MANIFEST = "/Users/pegmca/code/origin-data/finance-data/manifest/manifest.jsonl";

const goldenPath = process.argv[2] ?? DEFAULT_GOLDEN;
const manifestPath = process.argv[3] ?? DEFAULT_MANIFEST;

// 与 SCHEMA.md 保持一致的枚举定义。
const TYPE_ENUM = new Set([
  "numeric_fact", "definitional", "comparison", "multi_doc",
  "table", "unit_trap", "negative"
]);
const DIFFICULTY_ENUM = new Set(["easy", "medium", "hard"]);
const ANSWER_TYPE_ENUM = new Set(["number", "list", "table", "form", "text"]);
const SOURCE_KIND_ENUM = new Set(["text", "table", "image"]);
const REPORT_TYPE_ENUM = new Set([
  "annual", "interim", "q1", "q2", "q3",
  "prospectus", "announcement", "esg"
]);
const ID_RE = /^fin-\d{3,}$/;

/** 读取 manifest 中所有合法 ticker（用于 cross-check 作者集引用的公司是否存在）。 */
function loadManifestTickers(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const tickers = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.ticker === "string") tickers.add(obj.ticker);
    } catch {
      // manifest 单行长错不应阻断整批校验，跳过该行。
    }
  }
  return tickers;
}

/** 单条 case 的校验上下文，收集 error / warning。 */
class CaseReport {
  constructor(id) {
    this.id = id;
    this.errors = [];
    this.warnings = [];
  }
  err(msg) { this.errors.push(msg); }
  warn(msg) { this.warnings.push(msg); }
  get ok() { return this.errors.length === 0; }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateCase(obj, index, manifestTickers) {
  const rep = new CaseReport(obj.id ?? `line#${index + 1}`);

  // —— id ——
  if (typeof obj.id !== "string") {
    rep.err("缺少 id");
  } else if (!ID_RE.test(obj.id)) {
    rep.err(`id 格式应形如 fin-001，实际为 ${obj.id}`);
  }

  // —— 必填顶层字段 ——
  for (const f of ["query", "type", "difficulty", "answer_type", "gold_answer", "answer_unit", "note"]) {
    if (typeof obj[f] !== "string" || obj[f].length === 0) {
      rep.err(`缺少/空置必填字符串字段 ${f}`);
    }
  }
  for (const f of ["evidence", "distractors"]) {
    if (!Array.isArray(obj[f])) rep.err(`字段 ${f} 必须是数组`);
  }
  if (typeof obj.is_negative !== "boolean") rep.err("is_negative 必须是布尔");

  // —— 枚举 ——
  if (obj.type !== undefined && !TYPE_ENUM.has(obj.type)) rep.err(`type 非法：${obj.type}`);
  if (obj.difficulty !== undefined && !DIFFICULTY_ENUM.has(obj.difficulty)) rep.err(`difficulty 非法：${obj.difficulty}`);
  if (obj.answer_type !== undefined && !ANSWER_TYPE_ENUM.has(obj.answer_type)) rep.err(`answer_type 非法：${obj.answer_type}`);

  // —— negative 一致性 ——
  const evidence = obj.evidence ?? [];
  if (obj.is_negative === true) {
    if (evidence.length !== 0) rep.err("is_negative=true 时 evidence 必须为空数组（无源可检索）");
  } else if (evidence.length === 0) {
    rep.warn("非 negative 题 evidence 为空：将无法在评测中定位真值来源");
  }

  // —— evidence 逐项 ——
  for (const [i, e] of evidence.entries()) {
    if (!isPlainObject(e)) { rep.err(`evidence[${i}] 不是对象`); continue; }
    for (const f of ["ticker", "report_type", "period", "section", "quote", "source_kind"]) {
      if (typeof e[f] !== "string" || e[f].length === 0) rep.err(`evidence[${i}] 缺少字段 ${f}`);
    }
    if (typeof e.page !== "number") rep.err(`evidence[${i}].page 必须是数字`);
    if (e.source_kind !== undefined && !SOURCE_KIND_ENUM.has(e.source_kind)) rep.err(`evidence[${i}].source_kind 非法：${e.source_kind}`);
    if (e.report_type !== undefined && !REPORT_TYPE_ENUM.has(e.report_type)) rep.err(`evidence[${i}].report_type 非法：${e.report_type}`);
    if (e.source_kind === "image" && e.ocr_required !== true) rep.err(`evidence[${i}] 为图片源(source_kind=image) 必须 ocr_required=true`);
    if (e.ticker && manifestTickers && !manifestTickers.has(e.ticker)) {
      rep.err(`evidence[${i}].ticker=${e.ticker} 未命中 manifest.jsonl（语料中无此公司）`);
    }
  }

  // —— negative 的 resolution 特例 ——
  if (obj.is_negative === true) {
    if (!isPlainObject(obj.resolution) || obj.resolution.type !== "ticker_absent") {
      rep.err("is_negative=true 须带 resolution.type='ticker_absent'");
    }
  }

  // —— distractors 逐项 ——
  for (const [i, d] of (obj.distractors ?? []).entries()) {
    if (!isPlainObject(d)) { rep.err(`distractors[${i}] 不是对象`); continue; }
    for (const f of ["ticker", "report_type", "period"]) {
      if (typeof d[f] !== "string" || d[f].length === 0) rep.err(`distractors[${i}] 缺少字段 ${f}`);
    }
    if (d.report_type !== undefined && !REPORT_TYPE_ENUM.has(d.report_type)) rep.err(`distractors[${i}].report_type 非法：${d.report_type}`);
  }

  // —— 答案形态层 ——
  if (obj.type === "table") {
    if (!isPlainObject(obj.gold_answer_table) && !isPlainObject(obj.gold_answer_form)) {
      rep.err("type=table 必须提供 gold_answer_table 或 gold_answer_form");
    }
  }
  if ((obj.type === "numeric_fact" || obj.type === "comparison") && typeof obj.gold_answer === "string" && obj.gold_answer.trim().length === 0) {
    rep.err(`${obj.type} 题 gold_answer 不能为空`);
  }

  // —— 表格结构 ——
  if (isPlainObject(obj.gold_answer_table)) {
    const t = obj.gold_answer_table;
    if (!Array.isArray(t.columns) || t.columns.length === 0) rep.err("gold_answer_table.columns 必须是非空数组");
    if (!Array.isArray(t.rows)) rep.err("gold_answer_table.rows 必须是数组");
    if (Array.isArray(t.columns) && Array.isArray(t.rows)) {
      t.rows.forEach((r, ri) => {
        if (!Array.isArray(r)) { rep.err(`gold_answer_table.rows[${ri}] 不是数组`); return; }
        if (r.length !== t.columns.length) {
          rep.warn(`gold_answer_table.rows[${ri}] 列数(${r.length})与 columns(${t.columns.length})不一致（稀疏行允许，但请确认是否漏列）`);
        }
      });
    }
  }

  // —— 表单结构 ——
  if (isPlainObject(obj.gold_answer_form)) {
    const f = obj.gold_answer_form;
    if (!Array.isArray(f.items)) rep.err("gold_answer_form.items 必须是数组");
    else for (const [i, it] of f.items.entries()) {
      if (!isPlainObject(it) || typeof it.key !== "string" || typeof it.value !== "string") {
        rep.err(`gold_answer_form.items[${i}] 须含 key/value 字符串`);
      }
    }
  }

  // —— 快照 / 时间解析 ——
  if (obj.snapshot_dependent === true && !isPlainObject(obj.resolution)) {
    rep.err("snapshot_dependent=true 必须带 resolution（说明如何解析到报告期）");
  }
  if (isPlainObject(obj.resolution) && obj.resolution.type === "latest_by") {
    for (const f of ["field", "scope", "expected_report"]) {
      if (typeof obj.resolution[f] !== "string") rep.err(`resolution(latest_by) 缺少字段 ${f}`);
    }
  }

  return rep;
}

function main() {
  if (!existsSync(goldenPath)) {
    console.error(`✗ 找不到 golden 文件：${goldenPath}`);
    process.exit(1);
  }
  const manifestTickers = loadManifestTickers(manifestPath);
  if (!manifestTickers) {
    console.warn(`⚠ 未找到 manifest（${manifestPath}），跳过 ticker 存在性校验`);
  }

  const raw = readFileSync(goldenPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const reports = [];
  const seenIds = new Map();
  let parseErrors = 0;

  lines.forEach((line, i) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      parseErrors++;
      const r = new CaseReport(`line#${i + 1}`);
      r.err(`JSON 解析失败：${e.message}`);
      reports.push(r);
      return;
    }
    if (!isPlainObject(obj)) {
      parseErrors++;
      reports.push(Object.assign(new CaseReport(`line#${i + 1}`), { errors: ["非对象"] }));
      return;
    }
    const r = validateCase(obj, i, manifestTickers);
    if (typeof obj.id === "string") {
      if (seenIds.has(obj.id)) r.err(`id 重复：${obj.id}`);
      else seenIds.set(obj.id, i + 1);
    }
    reports.push(r);
  });

  // —— 输出 ——
  let totalErr = parseErrors;
  let totalWarn = 0;
  for (const r of reports) {
    totalErr += r.errors.length;
    totalWarn += r.warnings.length;
    if (r.errors.length || r.warnings.length) {
      console.log(`\n• ${r.id}  ${r.errors.length ? "✗" : "⚠"}`);
      for (const e of r.errors) console.log(`    ERROR  ${e}`);
      for (const w of r.warnings) console.log(`    WARN   ${w}`);
    }
  }

  console.log(`\n校验完成：${lines.length} 条，ERROR ${totalErr}，WARN ${totalWarn}`);
  process.exit(totalErr === 0 ? 0 : 1);
}

main();
