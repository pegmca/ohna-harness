/**
 * Task 5 工作流测试共享的真实文件系统夹具。
 *
 * PDF 由最小合法 xref 结构生成，manifest、golden 与草稿均写入隔离临时目录；
 * 测试结束后由各测试文件统一清理，避免触碰仓库作者集或语料。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 本进程内创建的临时根目录。 */
const tempDirs = [];

/**
 * 创建隔离工作区配置。
 *
 * @returns {object} WorkspaceConfig 测试值。
 */
export function makeWorkflowConfig() {
  const workspaceRoot = makeTempDir("golden-workflow-");
  const corpusRoot = makeTempDir("golden-corpus-");
  return {
    repoRoot: workspaceRoot,
    workspaceRoot,
    corpusRoot,
    manifestPath: join(corpusRoot, "manifest", "manifest.jsonl"),
    draftRoot: join(workspaceRoot, "datasets", "finance", "rag-golden", "_drafts"),
    goldenPath: join(workspaceRoot, "datasets", "finance", "rag-golden", "golden.jsonl"),
    generatedPath: join(workspaceRoot, "datasets", "finance", "rag-golden-v1.json"),
    backupRoot: join(workspaceRoot, "datasets", "finance", "rag-golden", "_backups")
  };
}

/**
 * 写入 manifest JSONL。
 *
 * @param {object} config 工作区配置。
 * @param {object[]} records manifest 记录。
 */
export function writeManifest(config, records) {
  mkdirSync(dirname(config.manifestPath), { recursive: true });
  writeFileSync(
    config.manifestPath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8"
  );
}

/**
 * 写入可由真实 PDF parser 读取的最小 PDF。
 *
 * @param {object} config 工作区配置。
 * @param {string} relativePath 语料相对路径。
 * @param {string|string[]} pages 页面文本。
 * @returns {Buffer} 写入的 PDF 原始字节。
 */
export function writePdf(config, relativePath, pages) {
  const bytes = buildMinimalPdf(Array.isArray(pages) ? pages : [pages]);
  const target = join(config.corpusRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

/**
 * 写入一段由真实解析器可见的 ASCII 长文本 PDF。
 *
 * 最小 PDF 的字体编码对连续 CJK 支持有限；需要验证页码与锚点定位时，
 * 使用此夹具避免把字体编码问题误判成 mine 工作流行为。
 *
 * @param {object} config 工作区配置。
 * @param {string} relativePath 语料相对路径。
 * @returns {Buffer} 写入的 PDF 字节。
 */
export function writeLongTextPdf(config, relativePath) {
  const page = (
    "Financial highlights Revenue 100 Operating cash flow 42 Total assets 300. "
  ).repeat(20);
  return writePdf(config, relativePath, page);
}

/**
 * 写入由真实解析器产生 `char_spaced` 层的候选 PDF。
 *
 * 页面行使用被空格拆开的 CJK 锚点，解析器会归一为带 `sourceLayer`
 * 的普通文本，由此验证 mine 使用真实的题型章节表而不是英语占位锚点。
 *
 * @param {object} config 工作区配置。
 * @param {string} relativePath 语料相对路径。
 * @returns {Buffer} 写入的 PDF 字节。
 */
export function writeAnchoredPdf(config, relativePath) {
  const firstLine =
    "主 要 会 计 数 据 Revenue 100 Operating cash flow 42 Total assets 300.";
  const filler =
    "Financial highlights Revenue 100 Operating cash flow 42 Total assets 300. "
      .repeat(20);
  return writePdf(config, relativePath, `${firstLine} ${filler}`);
}

/**
 * 写入 golden JSONL 并返回原始内容。
 *
 * @param {object} config 工作区配置。
 * @param {object[]} records golden 记录。
 * @returns {string} 写入的 UTF-8 文本。
 */
export function writeGolden(config, records) {
  const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  mkdirSync(dirname(config.goldenPath), { recursive: true });
  writeFileSync(config.goldenPath, content, "utf8");
  return content;
}

/**
 * 读取 golden 当前原始内容。
 *
 * @param {object} config 工作区配置。
 * @returns {string} golden 文本。
 */
export function readGolden(config) {
  return readFileSync(config.goldenPath, "utf8");
}

/**
 * 构造完整且可通过 Task 4 校验的作者记录。
 *
 * @param {object} overrides 字段覆盖值。
 * @returns {object} golden case。
 */
export function makeGoldenCase(overrides = {}) {
  const id = overrides.id ?? "fin-001";
  return {
    id,
    query: "What was revenue?",
    type: "numeric_fact",
    difficulty: "easy",
    answer_type: "number",
    gold_answer: "Revenue was 100.",
    answer_unit: "currency",
    evidence: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        section: "Financial highlights",
        page: 1,
        quote: "Revenue 100",
        source_kind: "table"
      }
    ],
    expected_keywords: ["Revenue 100"],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "Synthetic workflow fixture",
    ...overrides
  };
}

/**
 * 删除本测试进程创建的全部临时目录。
 */
export function cleanupWorkflowFixtures() {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 创建并登记临时目录。
 *
 * @param {string} prefix 目录前缀。
 * @returns {string} 真实绝对路径。
 */
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 生成最小多页 PDF。
 *
 * @param {string[]} pages 页面文本。
 * @returns {Buffer} PDF 字节。
 */
function buildMinimalPdf(pages) {
  const objectCount = 3 + pages.length * 2;
  const pageObjectStart = 3;
  const fontObject = 3 + pages.length * 2;
  const objects = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages
    .map((_, index) => `${pageObjectStart + index * 2} 0 R`)
    .join(" ");
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;

  pages.forEach((text, index) => {
    const pageObject = pageObjectStart + index * 2;
    const contentObject = pageObject + 1;
    objects[pageObject - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`;
    const content = `BT /F1 10 Tf 36 750 Td (${escapePdfText(text)}) Tj ET`;
    objects[contentObject - 1] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  objects[fontObject - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = [];
  for (let index = 0; index < objectCount; index += 1) {
    offsets.push(pdf.length);
    pdf = Buffer.concat([
      pdf,
      Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, "latin1")
    ]);
  }

  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  }
  pdf = Buffer.concat([pdf, Buffer.from(xref, "latin1")]);
  return Buffer.concat([
    pdf,
    Buffer.from(
      `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
      "latin1"
    )
  ]);
}

/**
 * 转义 PDF 字面字符串中的保留字符。
 *
 * @param {string} text 原始文本。
 * @returns {string} PDF 安全文本。
 */
function escapePdfText(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
