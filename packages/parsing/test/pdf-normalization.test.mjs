import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdfBlocks, countTableColumns, isTableRow } from "../dist/index.js";

const require = createRequire(import.meta.url);

/**
 * 生成只包含单页文本项的 stub pdf-parse 模块，用于验证 worker 的行聚合归一化。
 *
 * @param {Array<{str:string, x:number, width:number}>} items 同一 y 坐标上的文本项。
 * @returns {string} 可写入临时目录的 ESM 源码。
 */
function buildStubParserSource(items) {
  const contentItems = JSON.stringify(
    items.map((item) => ({ str: item.str, width: item.width, transform: [0, 0, 0, 0, item.x] }))
  );

  return [
    "export default async (_pdfBytes, options) => {",
    `  const page = { getTextContent: async () => ({ items: ${contentItems} }) };`,
    "  await options.pagerender(page);",
    "  return { numpages: 1, text: \"\" };",
    "};"
  ].join("\n");
}

/**
 * 通过真实 worker 源码和 stub parser 执行一次解析。
 *
 * @param {string} parserSource stub parser 的 ESM 源码。
 * @returns {Array<{text:string,sourceLayer:string}>} worker 输出的页面数组。
 */
function runWorker(parserSource) {
  const dir = mkdtempSync(join(tmpdir(), "parsing-pdf-normalize-"));
  const pdfPath = join(dir, "input.pdf");
  const parserPath = join(dir, "stub-parse.mjs");
  writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n"));
  writeFileSync(parserPath, parserSource);

  try {
    const { PDF_WORKER_SOURCE } = require("../dist/pdf-worker.js");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", PDF_WORKER_SOURCE], {
      env: { ...process.env, PARSING_PDF_PATH: pdfPath, PDF_PARSE_PATH: parserPath },
      maxBuffer: 16 * 1024 * 1024
    });
    return JSON.parse(output.toString("utf8")).pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("two-column rows with one stable gap are recognized, while prose is not", () => {
  assert.equal(isTableRow("董事会秘书    张利荣"), true);
  assert.equal(countTableColumns("董事会秘书    张利荣"), 2);
  assert.equal(isTableRow("公司主要从事稀土产品的生产与销售"), false);
  assert.equal(isTableRow("123    456"), false);
});

test("buildPdfBlocks keeps normalized rows and records sourceLayer for char-spaced PDF pages", () => {
  const blocks = buildPdfBlocks([
    {
      text: "华美公司　子公司\n213,252.00  462,419.73",
      sourceLayer: "char_spaced"
    }
  ]);

  assert.ok(blocks.length >= 1);
  assert.ok(blocks.every((block) => block.metadata?.sourceLayer === "char_spaced"));
  assert.match(blocks.map((block) => block.text).join("\n"), /华美公司　子公司/);
  assert.match(blocks.map((block) => block.text).join("\n"), /213,252\.00 {2}462,419\.73/);
});

test("full-width-space columns remain separated and count as a two-column table", () => {
  const line = "董事会秘书　张利荣";

  assert.equal(isTableRow(line), true);
  assert.equal(countTableColumns(line), 2);
  assert.equal(buildPdfBlocks([{ text: line, sourceLayer: "native" }])[0]?.text, line);
});

test("worker normalization merges CJK and broken numeric tokens without collapsing real columns", () => {
  const source = buildStubParserSource([
    { str: "华", x: 10, width: 9 },
    { str: "美", x: 19, width: 9 },
    { str: "公", x: 28, width: 9 },
    { str: "司", x: 37, width: 9 },
    { str: "子公司", x: 60, width: 27 },
    { str: "1", x: 120, width: 6 },
    { str: "0", x: 126, width: 6 },
    { str: "%", x: 132, width: 6 },
    { str: "67,78", x: 170, width: 30 },
    { str: "7", x: 200, width: 6 },
    { str: "(193)", x: 240, width: 30 },
    { str: "24", x: 290, width: 12 },
    { str: ".", x: 302, width: 3 },
    { str: "25", x: 305, width: 12 },
    { str: "-100", x: 350, width: 24 }
  ]);
  const pages = runWorker(source);

  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /华美公司 {2,}子公司/);
  assert.match(pages[0].text, /10% {2,}67,787 {2,}\(193\) {2,}24\.25 {2,}-100/);
  assert.equal(pages[0].sourceLayer, "char_spaced");
});
