/**
 * 金融财报 RAG 黄金评测集 · 半自动候选抽取器（扩作者集到 30–50 条的核心工具）。
 *
 * 作用：把「人工挑题」最烦的两步自动化——
 *   1) 从 manifest 定位真实 PDF；
 *   2) 按题型模板从解析全文里抽候选片段（含 page / quote），预填作者集字段骨架。
 * 人的职责只剩「确认 / 改数 / 补拆分 / 填 note」，不直接从 PDF 抄。
 *
 * 抽取健康度闸门（关键约束，已实测）：
 *   - 平安银行等年报抽出来是「字符间空格」层（平 安 银 行，每块一页），这种文件
 *     锚点搜索与子串匹配全废，必须拦截并标 extraction_health:"bad"，不落候选。
 *   - 归一：先 CJK 间距归一再搜锚点；空层 / 异常块密度也判 bad。
 *
 * 产物：落 `datasets/finance/rag-golden/_drafts/<batch>/<id>.jsonl`（未定稿草稿），
 * 人工补完真值后由 `test/promote-finance-golden.mjs` 合入 `golden.jsonl`。
 *
 * 用法：
 *   node test/mine-finance-golden.mjs <candidates.json> [<batch>]
 * candidates.json 形如：[{ "ticker":"600010.SH","report_type":"annual","period":"2025","type":"numeric_fact" }, ...]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePdfBlocks } from "../packages/parsing/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MANIFEST = "/Users/pegmca/code/origin-data/finance-data/manifest/manifest.jsonl";
const CORPUS_ROOT = "/Users/pegmca/code/origin-data/finance-data";
const DRAFT_DIR = resolve(REPO_ROOT, "datasets/finance/rag-golden/_drafts");

/** CJK 字符间空格归一（"平 安 银 行" → "平安银行"），保留数字/英文/标点间空格。 */
function normalizeCjk(text) {
  return text.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
}

/** 加载 manifest：ticker -> 记录数组（按披露日可排序）。 */
function loadManifest(path) {
  const byTicker = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const list = byTicker.get(o.ticker) ?? [];
    list.push(o);
    byTicker.set(o.ticker, list);
  }
  return byTicker;
}

/**
 * 抽取健康度判定：返回 { ok, reason, pages, blocks }。
 * bad 情形：每块一页且 CJK 带间空格（字符级 spacing 缺陷）；或有效文本过少。
 */
function checkExtractionHealth(text, blocks) {
  const pages = new Set(blocks.map((b) => b.pageNumber ?? 0)).size || 1;
  const blocksPerPage = blocks.length / pages;
  const spacedRatio = (text.match(/[\u4e00-\u9fff]\s[\u4e00-\u9fff]/g) ?? []).length;
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  // 每块一页 + 相当比例的 CJK 带间空格 => 字符级 spacing 缺陷（如平安银行年报）。
  if (blocksPerPage < 1.5 && cjkChars > 200 && spacedRatio > cjkChars * 0.15) {
    return { ok: false, reason: "字符间空格缺陷（每块一页，CJK 带间空格）", pages, blocks: blocks.length };
  }
  if (text.replace(/\s/g, "").length < 200) {
    return { ok: false, reason: "有效文本过少", pages, blocks: blocks.length };
  }
  return { ok: true, reason: "", pages, blocks: blocks.length };
}

/**
 * 题型锚点模板：按 type 给出在年报里最可能命中的章节标题与抽取窗口。
 * 返回 { anchor, window }：在归一全文里找 anchor，取其后 window 字作为候选 raw。
 */
const TYPE_ANCHORS = {
  numeric_fact: ["主要会计数据", "主要会计数据和财务指标", "会计数据"],
  comparison: ["主要会计数据", "主要会计数据和财务指标"],
  table: ["主要控股", "主要参股", "长期应收款", "坏账准备", "应收账款", "前五名"],
  form: ["联系人和联系方式", "联系人"],
  definitional: ["公司从事的主要业务", "主营业务", "经营范围"],
  multi_doc: ["主要会计数据", "主要会计数据和财务指标"],
  unit_trap: ["主要会计数据", "主要会计数据和财务指标"],
};

/**
 * 在归一全文里定位首个命中的锚点，返回 { anchor, page, window }。
 * 块级定位 page：先把每个 block 拼成 full text 并记录每块起始 offset，再按 offset 反查 page。
 */
function locateAnchor(blocks, anchors) {
  // 预构建块偏移表，便于把字符 offset 映射回 page。
  const normBlocks = blocks.map((b) => ({ page: b.pageNumber ?? 0, text: normalizeCjk(b.text) }));
  const offsets = [];
  let acc = 0;
  for (const b of normBlocks) {
    offsets.push(acc);
    acc += b.text.length + 1;
  }
  const full = normBlocks.map((b) => b.text).join("\n");
  for (const a of anchors) {
    const idx = full.indexOf(a);
    if (idx < 0) continue;
    // 反查 page：最后一个 offset <= idx 的块。
    let page = normBlocks[0]?.page ?? 0;
    for (let i = 0; i < offsets.length; i += 1) {
      if (offsets[i] <= idx) page = normBlocks[i].page;
      else break;
    }
    const window = full.slice(idx, idx + 600).replace(/\n/g, " ");
    return { anchor: a, page, window };
  }
  return null;
}

/** 为一条候选生成未定稿草稿（带预填骨架 + 候选证据）。 */
function buildNegativeDraft(candidate, nextId) {
  // 语料无此 ticker：产出 negative 反例骨架，等人工补 query / resolution。
  return {
    id: nextId,
    query: `（待填：${candidate.ticker} ${candidate.note ?? ""}）`,
    type: "negative",
    difficulty: "easy",
    answer_type: "text",
    gold_answer: "（待填：语料中无该 ticker 的财报）",
    answer_unit: "文本",
    evidence: [],
    requires_multi_doc: false,
    distractors: [],
    is_negative: true,
    note: "negative 反例：语料无此 ticker，应拒答/不应编造",
    resolution: { type: "ticker_absent", ticker: candidate.ticker },
    _draft: { ticker: candidate.ticker, type: "negative", extraction_health: "n/a" },
  };
}

/** 把 (ticker, report_type, period) 解析为命中记录；命中不到返回 null。 */
function resolveRecord(manifest, ticker, report_type, period) {
  const list = manifest.get(ticker) ?? [];
  return list.find((m) => m.report_type === report_type && m.period === period) ?? null;
}

function buildDraft(candidate, manifest, nextId) {
  const { ticker, report_type, period, type } = candidate;
  const list = manifest.get(ticker) ?? [];
  const hit = resolveRecord(manifest, ticker, report_type, period);
  // negative 题且语料确无此 ticker：产出反例骨架（不抽 PDF）。
  if (!hit) {
    if (type === "negative") return { negative: true, draft: buildNegativeDraft(candidate, nextId) };
    return { skipped: true, reason: `manifest 无 ${ticker}/${report_type}/${period}`, id: nextId };
  }
  const absPath = resolve(CORPUS_ROOT, hit.file_path);
  if (!existsSync(absPath)) {
    return { skipped: true, reason: `磁盘无文件 ${hit.file_path}`, id: nextId };
  }
  const bytes = new Uint8Array(readFileSync(absPath));
  const blocks = parsePdfBlocks(bytes);
  const full = blocks.map((b) => b.text).join("\n");
  const norm = normalizeCjk(full);
  const health = checkExtractionHealth(norm, blocks);
  if (!health.ok) {
    return {
      skipped: true,
      reason: `抽取健康度 bad：${health.reason}`,
      id: nextId,
      extraction_health: "bad",
      file_path: hit.file_path,
    };
  }
  const loc = locateAnchor(blocks, TYPE_ANCHORS[type] ?? TYPE_ANCHORS.numeric_fact);
  // multi_doc：把额外报告期也列为 evidence（同 ticker/report_type，不同 period）。
  const extraPeriods = Array.isArray(candidate.periods) ? candidate.periods.filter((p) => p !== period) : [];
  const extraEvidence = [];
  for (const p of extraPeriods) {
    const r = resolveRecord(manifest, ticker, report_type, p);
    if (r) extraEvidence.push({ ticker, report_type, period: p, section: "（待补：跨报告期）", page: 0, quote: "", source_kind: "text" });
  }
  const evidence = [
    {
      ticker,
      report_type,
      period,
      section: loc ? `（候选：${loc.anchor}）` : "（待补：章节）",
      page: loc ? loc.page : 0,
      quote: loc ? loc.window : "",
      source_kind: "text",
    },
    ...extraEvidence,
  ];
  return {
    id: nextId,
    query: `（待填：${ticker} ${period} ${type}）`,
    type,
    difficulty: type === "negative" ? "easy" : "medium",
    answer_type: type === "table" || type === "form" ? "table" : type === "definitional" ? "text" : "number",
    gold_answer: "",
    answer_unit: "（待补）",
    evidence,
    requires_multi_doc: type === "multi_doc" || extraEvidence.length > 0,
    distractors: [],
    is_negative: false,
    note: loc ? `候选锚点=${loc.anchor}@p${loc.page}；人工补真值/拆分` : "未命中锚点，人工定位",
    _draft: {
      ticker,
      report_type,
      period,
      type,
      file_path: hit.file_path,
      extraction_health: "ok",
      extra_periods: extraPeriods,
      candidate_window: loc ? loc.window : "",
    },
  };
}

function main() {
  const candidatesPath = process.argv[2];
  const batch = process.argv[3] ?? `batch-${new Date().toISOString().slice(0, 10)}`;
  if (!candidatesPath) {
    console.error("用法：node test/mine-finance-golden.mjs <candidates.json> [<batch>]");
    process.exit(1);
  }
  const manifest = loadManifest(MANIFEST);
  const candidates = JSON.parse(readFileSync(resolve(REPO_ROOT, candidatesPath), "utf8"));

  const outDir = resolve(DRAFT_DIR, batch);
  mkdirSync(outDir, { recursive: true });

  let next = 1;
  let skipped = 0;
  const draftLines = [];
  for (const c of candidates) {
    const id = `fin-D${String(next).padStart(3, "0")}`;
    const draft = buildDraft(c, manifest, id);
    if (draft.negative) {
      next += 1;
      const line = JSON.stringify(draft.draft);
      draftLines.push(line);
      writeFileSync(resolve(outDir, `${id}.jsonl`), line + "\n", "utf8");
      console.log(`  NEG   ${id} ${c.ticker}（语料无）→ negative 骨架`);
      continue;
    }
    if (draft.skipped) {
      skipped += 1;
      console.log(`  SKIP ${id} ${c.ticker}/${c.report_type}/${c.period}/${c.type}: ${draft.reason}`);
      continue;
    }
    next += 1;
    const line = JSON.stringify(draft);
    draftLines.push(line);
    writeFileSync(resolve(outDir, `${id}.jsonl`), line + "\n", "utf8");
    console.log(`  DRAFT ${id} ${c.ticker}/${c.report_type}/${c.period}/${c.type} 锚点=${draft.note.split("；")[0]}`);
  }

  // 批次索引：记录本批产出的 id 与候选数，便于 promote 与复盘。
  writeFileSync(
    resolve(outDir, "_index.json"),
    JSON.stringify({ batch, generatedAt: new Date().toISOString(), drafted: draftLines.length, skipped, candidates }, null, 2),
    "utf8"
  );
  console.log(`\n完成 batch=${batch}：草稿 ${draftLines.length} 条，跳过 ${skipped} 条 → ${outDir}`);
}

main();
