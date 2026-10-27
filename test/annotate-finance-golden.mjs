/**
 * 金融财报 RAG 黄金评测集 · 简易 Web 标注服务（零依赖）。
 *
 * 目的：避免人工直接改 JSONL 的繁琐。本服务把 `mine-finance-golden.mjs` 产出的
 * `_drafts/<batch>/*.jsonl` 草稿渲染成可填表单，人工补完真值后写回原文件，
 * 再由 `test/promote-finance-golden.mjs` 定稿入册 `golden.jsonl`。
 *
 * 能力：
 * - 列出某批次全部草稿（id / type / 是否已审核 / 抽取健康度）。
 * - 单条编辑：query / type / difficulty / answer_type / gold_answer / answer_unit /
 *   gold_answer_table（表格网格）/ gold_answer_form（键值表单）/ evidence[].section /
 *   distractors / note，以及「已抽取锚点原文」与原文 PDF 链接预览。
 * - 勾选「标记已审核」写回 `_draft.approved=true`，让 promote 闸门放行。
 *
 * 用法：
 *   node test/annotate-finance-golden.mjs [port]      # 默认端口 5174
 *   PORT=5180 node test/annotate-finance-golden.mjs
 * 启动后浏览器打开 http://localhost:5174/
 */
import { createServer } from "node:http";
import {
  readFileSync, writeFileSync, readdirSync, existsSync, statSync,
} from "node:fs";
import { resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DRAFT_ROOT = resolve(REPO_ROOT, "datasets/finance/rag-golden/_drafts");
const CORPUS_ROOT = "/Users/pegmca/code/origin-data/finance-data";
const UI_HTML = resolve(HERE, "annotate-finance-golden.html");
const PORT = Number(process.env.PORT ?? process.argv[2] ?? 5174);

/** 列出 _drafts 下的批次目录名。 */
function listBatches() {
  if (!existsSync(DRAFT_ROOT)) return [];
  return readdirSync(DRAFT_ROOT)
    .filter((d) => {
      try { return statSync(resolve(DRAFT_ROOT, d)).isDirectory(); } catch { return false; }
    })
    .sort();
}

/** 批次内所有草稿文件（排除 _index.json 等以 _ 开头的元文件）。 */
function draftFiles(batch) {
  const dir = resolve(DRAFT_ROOT, batch);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("_")).sort();
}

function readDraft(batch, id) {
  const p = resolve(DRAFT_ROOT, batch, `${id}.jsonl`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeDraft(batch, id, obj) {
  const dir = resolve(DRAFT_ROOT, batch);
  writeFileSync(resolve(dir, `${id}.jsonl`), JSON.stringify(obj) + "\n", "utf8");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** 列表页（服务端渲染），展示某批次全部草稿与审核状态。 */
function renderList(batch) {
  const batches = listBatches();
  if (batches.length === 0) {
    return `<p>未找到任何批次目录：<code>${DRAFT_ROOT}</code></p>`;
  }
  const active = batch && batches.includes(batch) ? batch : batches[batches.length - 1];
  const nav = batches
    .map((b) => `<a class="batch ${b === active ? "on" : ""}" href="/?batch=${encodeURIComponent(b)}">${escapeHtml(b)}</a>`)
    .join("");
  const files = draftFiles(active);
  const rows = files.length
    ? files
        .map((f) => {
          const d = readDraft(active, f.replace(/\.jsonl$/, ""));
          if (!d) return "";
          const health = d._draft?.extraction_health ?? "-";
          const approved = d._draft?.approved === true;
          const placeholder = (d.query ?? "").startsWith("（待填");
          const status = approved ? "✅ 已审核" : placeholder ? "📝 待填" : "⏳ 未审核";
          return `<tr>
            <td><a href="/edit?batch=${encodeURIComponent(active)}&id=${encodeURIComponent(d.id)}">${escapeHtml(d.id)}</a></td>
            <td>${escapeHtml(d.type)}</td>
            <td class="${placeholder ? "muted" : ""}">${escapeHtml(d.query)}</td>
            <td>${escapeHtml(health)}</td>
            <td class="${approved ? "ok" : "warn"}">${status}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5">本批次暂无草稿，先跑 <code>node test/mine-finance-golden.mjs</code> 抽取候选。</td></tr>`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>财报 RAG 标注 · 草稿列表</title>
<style>
  :root { color-scheme: dark; --bg:#18191A; --panel:#202224; --line:#2c2f31; --fg:#e8eaec; --muted:#9aa0a6; --accent:#89D7B7; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--line); }
  h1 { font-size:18px; margin:0 0 10px; }
  .batch { display:inline-block; padding:4px 10px; margin-right:6px; border:1px solid var(--line); border-radius:6px; color:var(--muted); text-decoration:none; }
  .batch.on { color:var(--bg); background:var(--accent); border-color:var(--accent); }
  main { padding:18px 24px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .ok { color:var(--accent); } .warn { color:#e8c07d; } .muted { color:var(--muted); }
</style></head><body>
<header><h1>财报 RAG 黄金集 · 草稿标注</h1><div>${nav}</div></header>
<main>
  <p class="muted">批次 <b>${escapeHtml(active)}</b> · 共 ${files.length} 条草稿。点击 id 进入逐条标注。</p>
  <table><thead><tr><th>id</th><th>题型</th><th>query</th><th>抽取健康度</th><th>状态</th></tr></thead>
  <tbody>${rows}</tbody></table>
</main></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    // 静态 UI 与列表。
    if (p === "/" && req.method === "GET") {
      const batch = url.searchParams.get("batch");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderList(batch ?? undefined));
      return;
    }
    if (p === "/edit" && req.method === "GET") {
      if (!existsSync(UI_HTML)) { res.writeHead(404); res.end("UI 文件缺失"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(UI_HTML, "utf8"));
      return;
    }

    // 批次列表。
    if (p === "/api/batches" && req.method === "GET") {
      sendJson(res, 200, { batches: listBatches() });
      return;
    }

    // 草稿清单（含轻量元信息，供前端展示）。
    if (p === "/api/drafts" && req.method === "GET") {
      const batch = url.searchParams.get("batch");
      if (!batch) { sendJson(res, 400, { error: "缺少 batch" }); return; }
      const items = draftFiles(batch).map((f) => {
        const d = readDraft(batch, f.replace(/\.jsonl$/, ""));
        return {
          id: d?.id, type: d?.type, query: d?.query,
          health: d?._draft?.extraction_health,
          approved: d?._draft?.approved === true,
          is_negative: d?.is_negative === true,
        };
      });
      sendJson(res, 200, { batch, items });
      return;
    }

    // 单条草稿全文。
    if (p === "/api/draft" && req.method === "GET") {
      const batch = url.searchParams.get("batch");
      const id = url.searchParams.get("id");
      if (!batch || !id) { sendJson(res, 400, { error: "缺少 batch 或 id" }); return; }
      const d = readDraft(batch, id);
      if (!d) { sendJson(res, 404, { error: "草稿不存在" }); return; }
      sendJson(res, 200, d);
      return;
    }

    // 保存单条草稿（前端回传完整对象，服务端原样写回）。
    if (p === "/api/draft" && req.method === "POST") {
      const batch = url.searchParams.get("batch");
      const id = url.searchParams.get("id");
      if (!batch || !id) { sendJson(res, 400, { error: "缺少 batch 或 id" }); return; }
      const body = await readBody(req);
      let obj;
      try { obj = JSON.parse(body); } catch { sendJson(res, 400, { error: "JSON 解析失败" }); return; }
      if (obj.id !== id) { sendJson(res, 400, { error: "id 与路径不一致" }); return; }
      writeDraft(batch, id, obj);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    // 原文 PDF 预览（带路径穿越防护，仅允许访问语料根下文件）。
    if (p === "/pdf" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = normalize(resolve(CORPUS_ROOT, rel));
      if (!abs.startsWith(CORPUS_ROOT) || !existsSync(abs) || extname(abs).toLowerCase() !== ".pdf") {
        res.writeHead(404); res.end("文件不存在"); return;
      }
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(readFileSync(abs));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.log(`财报 RAG 标注服务已启动：http://localhost:${PORT}/`);
  console.log(`  草稿根目录：${DRAFT_ROOT}`);
  console.log(`  语料根目录：${CORPUS_ROOT}`);
  console.log(`  批次：${(listBatches().join(", ") || "（无）")}`);
});
