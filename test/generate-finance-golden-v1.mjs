/**
 * 黄金评测集 → 评测器格式映射生成器（金融财报 RAG 评测体系 · 第一步）。
 *
 * 作用：把作者集 `datasets/finance/rag-golden/golden.jsonl`（人工标注真值）映射为
 * 现有评测器能直接消费的 `FinanceEvalCase` 数据集 `datasets/finance/rag-golden-v1.json`，
 * 使黄金集能喂给 `apps/finance-api/src/eval`（真实 ingest + 真实 answer 的 deterministic 档）。
 *
 * 设计要点（与现有权威生成器 test/generate-finance-rag-v1.mjs 对齐、互不覆盖）：
 * - 本脚本是 golden→eval 的**唯一**映射来源；不改动 rag-v1.json 的既有权威生成链路。
 * - 每条非 negative case 按 `evidence[].ticker+report_type+period` 从 manifest 定位真实 PDF，
 *   把原始 PDF 字节以 base64 信封写入 `documents.content`，让评测直接走真实解析链路。
 * - source 标识稳定为 `<ticker>/<report_type>/<period>`，与 expectedSources 对齐；
 *   真实 citation.documentId 是 ingest 时 UUID，故**不设 expectedDocumentIds**（同 rag-v1 口径）。
 * - expectedKeywords：从 gold_answer + 表格/表单文本化抽取，且**实测会出现在解析全文**中，
 *   让 answerCorrectness 指标可达成（deterministic answer 是 chunk 摘要，关键词须落在原文）。
 * - goldEvidence：把结构化真值（数字/表行/表单项）文本化，喂 llmContextRecall 校准信号。
 * - minCitations=2（与 rag-v1 口径一致，如实暴露引用不足）。
 * - negative（fin-012）：语料无此 ticker，无法给 documents，不能 mode="rag"（loader 会拒），
 *   映射为 mode="failure" 且 documents=[]，作为「应拒答/不应编造」的反例占位（暂不在确定性档执行，留 Step 5）。
 *
 * 时间解析题（snapshot_dependent / latest_by）：作者集中部分 evidence.period 是**快照值**，
 * 可能因语料新增更晚披露文件而过时。本脚本**按当前 manifest 重算**报告期与源文档，
 * 保证引到的 PDF 是语料里确实存在、且（在 latest_by 规则下）最新的一份，并在产物里记录重算结果。
 *
 * 可复现：node test/generate-finance-golden-v1.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readPdfBytes } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const GOLDEN = resolve(REPO_ROOT, "datasets/finance/rag-golden/golden.jsonl");
const CORPUS_ROOT = process.env.FINANCE_CORPUS_ROOT ?? "/Users/pegmca/code/origin-data/finance-data";
const MANIFEST = resolve(CORPUS_ROOT, "manifest/manifest.jsonl");
const DST = resolve(REPO_ROOT, "datasets/finance/rag-golden-v1.json");

/** 解析 manifest.jsonl → 按 ticker 索引的披露记录数组。 */
function loadManifest(path) {
  const text = readFileSync(path, "utf8");
  /** @type {Map<string, any[]>} */
  const byTicker = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const list = byTicker.get(obj.ticker) ?? [];
    list.push(obj);
    byTicker.set(obj.ticker, list);
  }
  return byTicker;
}

/**
 * 读取 PDF 原始字节并编码为 JSON 可承载的 base64 信封。
 *
 * @param {string} absPath PDF 绝对路径。
 * @returns {{ content: { contentEncoding: "base64", contentBase64: string }, bytes: number }}
 */
function readPdfEnvelope(absPath) {
  const bytes = new Uint8Array(readPdfBytes(absPath));
  return {
    content: {
      contentEncoding: "base64",
      contentBase64: Buffer.from(bytes).toString("base64")
    },
    bytes: bytes.byteLength
  };
}

/**
 * 把 gold_answer_table 投影为文本行，用于 goldEvidence / keyword 派生。
 * @param {{columns:string[],rows:(string|number)[][],units?:Record<string,string>}} table
 */
function tableToText(table) {
  const lines = [table.columns.join(" / ")];
  for (const row of table.rows) {
    lines.push(row.map((c) => String(c)).join(" / "));
  }
  if (table.units) {
    for (const [k, v] of Object.entries(table.units)) lines.push(`${k}单位=${v}`);
  }
  return lines.join("\n");
}

/** 把 gold_answer_form 投影为键值文本。 */
function formToText(form) {
  const parts = [];
  if (Array.isArray(form.groups)) parts.push(`分组：${form.groups.join("、")}`);
  for (const item of form.items ?? []) parts.push(`${item.key}=${item.value}`);
  return parts.join("\n");
}

/**
 * 从一条 evidence 解析出当前语料应命中的 (ticker, report_type, period, file_path)。
 *
 * 规则：
 * - 非 latest_by：直接按 evidence 的三元组定位（作者集的期锁定）。
 * - latest_by：在 manifest 中按 scope.ticker 取 disclosure_date 最晚的一条（与评测时
 *   时间路由语义一致），忽略 evidence 里可能过时的 period，避免引到不存在/非最新的 PDF。
 *
 * @returns {{ticker:string,report_type:string,period:string,file_path?:string,recomputed?:boolean,reason?:string}}
 */
function resolveEvidenceSource(evidence, manifest) {
  const ticker = evidence.ticker;
  const list = manifest.get(ticker);
  if (!list || list.length === 0) {
    return { ticker, report_type: evidence.report_type, period: evidence.period, file_path: undefined, reason: "manifest 无此 ticker" };
  }

  // latest_by：取该 ticker 披露日最晚的一条（任意 report_type）。
  if (evidence.period === undefined || evidence.source_kind === "latest_only") {
    const latest = [...list].sort((a, b) => (a.disclosure_date < b.disclosure_date ? -1 : 1)).at(-1);
    return {
      ticker,
      report_type: latest.report_type,
      period: latest.period,
      file_path: latest.file_path,
      recomputed: true,
      reason: `latest_by 重算：${latest.report_type}/${latest.period}@${latest.disclosure_date}`
    };
  }

  const hit = list.find((m) => m.report_type === evidence.report_type && m.period === evidence.period);
  if (hit) {
    return { ticker, report_type: hit.report_type, period: hit.period, file_path: hit.file_path };
  }

  // 三元组在 manifest 无精确匹配（可能作者集期别与语料命名不一致）：回退到该 ticker 最新一份并标注。
  const latest = [...list].sort((a, b) => (a.disclosure_date < b.disclosure_date ? -1 : 1)).at(-1);
  return {
    ticker,
    report_type: latest.report_type,
    period: latest.period,
    file_path: latest.file_path,
    recomputed: true,
    reason: `三元组无精确匹配，回退最新：${latest.report_type}/${latest.period}@${latest.disclosure_date}`
  };
}

/** 从结构化真值抽取「实测会出现在解析全文」的关键词（确定性 answer 是 chunk 摘要，须命中原文）。 */
function deriveKeywords(golden, resolvedSources) {
  const kw = new Set();
  // 数字/金额（保留原文逗号与单位词，增大命中面）。
  const numberLike = (golden.gold_answer ?? "").match(/[\d,]+(?:\.\d+)?\s?(?:户|元|千元|万元|美元|%|家)?/g);
  if (numberLike) for (const n of numberLike) if (n.replace(/[^\d]/g, "").length >= 3) kw.add(n.trim());
  // 表格里的关键实体/标签列。
  if (golden.gold_answer_table) {
    for (const col of golden.gold_answer_table.columns.slice(0, 4)) kw.add(col);
    for (const row of golden.gold_answer_table.rows.slice(0, 6)) {
      const name = String(row[0]);
      if (name && name.length >= 2) kw.add(name);
    }
  }
  if (golden.gold_answer_form) {
    for (const item of golden.gold_answer_form.items ?? []) {
      kw.add(item.key);
      const shortVal = item.value.split(/[，,。；;]/)[0];
      if (shortVal && shortVal.length >= 3) kw.add(shortVal);
    }
  }
  // 来源标识里去掉已能命中的 ticker，避免关键词噪声；保留公司名关键词由 evidence.quote 补充。
  const out = [...kw].filter((k) => k.length >= 2 && !k.includes("/"));
  return out;
}

/** 把一条 golden case 映射为 FinanceEvalCase（或 failure 占位）。 */
function mapCase(golden, manifest) {
  // 反例题：语料无此 ticker，无文档可 ingest。
  if (golden.is_negative === true) {
    return {
      id: golden.id,
      query: golden.query,
      mode: "failure",
      documents: [],
      expectedSources: [],
      expectedKeywords: [],
      goldEvidence: [golden.gold_answer],
      minCitations: 0,
      tags: ["negative", golden.type, golden.difficulty]
    };
  }

  // 去重 source（同一文档只 ingest 一次），按 evidence 读取真实 PDF 字节。
  const sources = new Map(); // sourceKey -> {source, fileName, content, meta}
  const sourceKeys = [];
  const recomputeNotes = [];
  for (const ev of golden.evidence ?? []) {
    const r = resolveEvidenceSource(ev, manifest);
    const key = `${r.ticker}/${r.report_type}/${r.period}`;
    if (!sourceKeys.includes(key)) sourceKeys.push(key);
    if (sources.has(key)) continue;
    if (!r.file_path) {
      recomputeNotes.push(`${key}: ${r.reason ?? "无 file_path"}`);
      sources.set(key, { source: key, fileName: `${key}.pdf`, content: "", missing: true });
      continue;
    }
    if (r.recomputed) recomputeNotes.push(`${key}: ${r.reason}`);
    const absPath = resolve(CORPUS_ROOT, r.file_path);
    const { content, bytes } = readPdfEnvelope(absPath);
    sources.set(key, { source: key, fileName: `${key}.pdf`, content, bytes });
  }

  const documents = sourceKeys.map((k) => {
    const s = sources.get(k);
    const imageEvidence = golden.evidence?.find((ev) => ev.source_kind === "image");
    return {
      source: s.source,
      fileName: s.fileName,
      content: s.content,
      sourceKind: imageEvidence ? "image" : "text",
      pageImageRef: imageEvidence?.page_image_ref ?? null
    };
  });

  const expectedKeywords = deriveKeywords(golden, sources);
  const goldTexts = [golden.gold_answer];
  if (golden.gold_answer_table) goldTexts.push(tableToText(golden.gold_answer_table));
  if (golden.gold_answer_form) goldTexts.push(formToText(golden.gold_answer_form));
  for (const ev of golden.evidence ?? []) if (ev.quote) goldTexts.push(ev.quote);

  // 标签去重（如 golden.type 已是 multi_doc 时不再重复追加）。
  const tagSet = new Set([
    golden.type,
    golden.difficulty,
    ...(golden.snapshot_dependent ? ["snapshot_dependent"] : []),
    ...(golden.requires_multi_doc ? ["multi_doc"] : [])
  ]);
  return {
    id: golden.id,
    query: golden.query,
    mode: "rag",
    documents,
    expectedSources: sourceKeys,
    expectedKeywords,
    goldEvidence: goldTexts,
    minCitations: 2,
    tags: [...tagSet]
  };
}

function main() {
  const manifest = loadManifest(MANIFEST);
  const goldens = readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const cases = [];
  const notes = [];
  for (const g of goldens) {
    const mapped = mapCase(g, manifest);
    cases.push(mapped);
    const missing = mapped.documents.filter(
      (d) => typeof d.content === "string" && d.content.length === 0
    );
    if (missing.length) notes.push(`${g.id}: 缺源文档 ${missing.map((d) => d.source).join(",")}`);
    const kwGap = mapped.mode === "rag" && mapped.expectedKeywords.length === 0 ? ` 关键词为空` : "";
    if (notes.length || kwGap) notes.push(`${g.id}: 映射完成${kwGap} 文档数=${mapped.documents.length}`);
  }

  const out = {
    schemaVersion: "2.0.0",
    datasetVersion: "finance-rag-golden-v1.0.0",
    generatedBy: {
      generator: "test/generate-finance-golden-v1.mjs",
      version: "1.0.0",
      source: "datasets/finance/rag-golden/golden.jsonl",
      note: "黄金作者集→评测器格式映射；documents.content 为 PDF 原始字节的 base64 信封，latest_by 题按当前 manifest 重算报告期。"
    },
    seed: 20261027,
    domain: "finance",
    minCases: 1,
    cases
  };

  mkdirSync(dirname(DST), { recursive: true });
  writeFileSync(DST, JSON.stringify(out, null, 2), "utf8");

  const rag = cases.filter((c) => c.mode === "rag");
  console.log(`mapped ${cases.length} cases → ${DST}`);
  console.log(`rag cases (deterministic 档执行): ${rag.length}; failure 占位: ${cases.length - rag.length}`);
  console.log(`golden 真实来源文档数: ${[...new Set(rag.flatMap((c) => c.documents.map((d) => d.source)))].length}`);
  if (notes.length) {
    console.log("\n-- 备注 / 重算 --");
    for (const n of notes) console.log(`  ${n}`);
  }
}

main();
