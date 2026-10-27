import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentParser, ParsedBlock, ParserInput } from "../types.js";
import { collectParagraphBlocks, splitLines } from "../block-collector.js";
import { PDF_WORKER_SOURCE } from "../pdf-worker.js";

/** 子进程输出的单页文本及其文本层诊断。 */
interface ParsedPdfPage {
  text: string;
  sourceLayer: "native" | "char_spaced";
}

/**
 * 解析 PDF 二进制内容为带 pageNumber 与表格标记的 block 草稿。
 *
 * WHY：PDF 是文档解析的高频来源，但原生异步解析不能直接塞进同步 ingestion 边界，
 * 因此交给子进程同步回收（见 pdf-worker.ts 的 PDF_WORKER_SOURCE）。每个 page 的文本
 * 按行切分，表格行被单独标记为 block.metadata.isTableRow，便于 RAG chunk 与 citation
 * 保留"第几页/第几行/是否表格"的精准位置线索。
 *
 * @param content PDF 原始字节。
 * @returns 带 pageNumber 与表格标记的解析 block 草稿；解析失败向上抛出，由 facade 收敛为结构化错误。
 */
export function parsePdfBlocks(content: Uint8Array): ParsedBlock[] {
  // 解析依赖在运行时才需要：这里只做路径解析，未安装时抛出可被上层捕获的明确错误。
  const require = createRequire(import.meta.url);
  let pdfParsePath: string;

  try {
    pdfParsePath = require.resolve("pdf-parse");
  } catch {
    throw new Error("pdf-parse 未安装：请先执行 pnpm install 注入 PDF 解析依赖。");
  }

  const dir = mkdtempSync(join(tmpdir(), "parsing-pdf-"));
  const pdfPath = join(dir, "input.pdf");
  writeFileSync(pdfPath, content);

  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PDF_WORKER_SOURCE], {
      env: { ...process.env, PARSING_PDF_PATH: pdfPath, PDF_PARSE_PATH: pdfParsePath },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000
    });
    const parsed = JSON.parse(out.toString("utf-8")) as
      | {
          pages: Array<ParsedPdfPage | string>;
          numpages: number;
        }
      | string[];

    return buildPdfBlocks(
      (Array.isArray(parsed) ? parsed : parsed.pages).map((page) =>
        typeof page === "string" ? { text: page, sourceLayer: "native" } : page
      )
    );
  } finally {
    // 无论成功失败都清理临时 PDF，避免磁盘泄漏。
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把子进程返回的逐页文本转换为 ParsedBlock[]。
 *
 * 逐页处理：每页文本按行切分，连续非表格行聚合成段落 block，表格行单独成块并打标。
 * 段落累积 / flush / 行号簿记交给共享骨架 collectParagraphBlocks；本函数只保留 pdf
 * 特有差异：每页重置段落、附加 pageNumber，并把表格行识别为独立块。
 *
 * @param pages 子进程解析出的逐页纯文本（已按 y 坐标切好行）。
 * @returns 带 pageNumber 与表格标记的解析 block 草稿。
 */
export function buildPdfBlocks(pages: readonly ParsedPdfPage[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  pages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const pageMetadata: Record<string, string | number | boolean | null> =
      page.sourceLayer === "char_spaced" ? { sourceLayer: page.sourceLayer } : {};

    collectParagraphBlocks(
      splitLines(page.text),
      ({ text, lineStart, lineEnd }) => {
        blocks.push({ text, pageNumber, lineStart, lineEnd, metadata: pageMetadata });
      },
      (line, lineNumber, flush) => {
        // 表格行单独成块并打标，避免与相邻正文段落混在同一 block。
        if (!isTableRow(line)) {
          return undefined;
        }

        flush(lineNumber - 1);
        blocks.push({
          text: line.trim(),
          pageNumber,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          metadata: {
            ...pageMetadata,
            isTableRow: true,
            tableColumnCount: countTableColumns(line)
          }
        });
        return "skip";
      }
    );
  });

  return blocks;
}

/**
 * 识别"表格行"：制表符、markdown 竖线、至少两处 ASCII 列间隔，或一处稳定间隔的两列表。
 *
 * WHY：把表格信息存进 block.metadata（而非丢弃或并入正文），是因为 RAG 检索与
 * citation 需要区分"这是一段叙述"还是"这是一张表格的一行"，从而保留结构化语义线索，
 * 且 metadata 的值为简单标量（不存数组），符合 IngestedTextBlockDto 的序列化约束。
 *
 * @param line 单行文本。
 * @returns 是否为表格行。
 */
export function isTableRow(line: string): boolean {
  if (line.includes("\t")) {
    return true;
  }

  if (line.includes("|")) {
    return true;
  }

  const stableGaps = line.split(/[ \t]{2,}|\u3000+/).filter((cell) => cell.trim().length > 0);

  if (stableGaps.length >= 3) {
    return true;
  }

  if (stableGaps.length !== 2) {
    return false;
  }

  // 两列表要求首列非纯数字，避免把正文里的编号/多个数字误判成表格。
  return !/^[\d,.%()+\-\s]+$/.test(stableGaps[0].trim());
}

/**
 * 估算表格行的列数，用于写入 metadata.tableColumnCount。
 *
 * @param line 已识别为表格行的单行文本。
 * @returns 估算的列数。
 */
export function countTableColumns(line: string): number {
  if (line.includes("|")) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0).length;
  }

  if (line.includes("\t")) {
    return line.split("\t").filter((cell) => cell.trim().length > 0).length;
  }

  return line.split(/[ \t]{2,}|\u3000+/).filter((cell) => cell.trim().length > 0).length;
}

/** `%PDF-` 的字节序列（0x25 0x50 0x44 0x46 0x2D）。 */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * PDF 文件头的搜索窗口（字节）。
 *
 * ISO 32000-1 §7.5.2 允许文件头前有最多 1024 字节前导内容（BOM / 空白 / 拼接残留），
 * 合规 reader 应容忍；pdf.js 也正是这么做的。因此这里不能只在偏移 0 校验，
 * 否则会拒掉旧 ingestFiling 能成功解析的合法 PDF（行为回归）。
 */
const PDF_HEADER_SEARCH_WINDOW = 1024;

/**
 * 校验内容是否在前 1024 字节内出现 PDF magic bytes（`%PDF-`）。
 *
 * @param content 待校验内容，字符串会按 UTF-8 编码后再比较字节。
 * @returns 是否具备 PDF 文件头。
 */
function hasPdfMagicBytes(content: string | Uint8Array): boolean {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const limit = Math.min(bytes.length, PDF_HEADER_SEARCH_WINDOW);

  for (let offset = 0; offset + PDF_MAGIC.length <= limit; offset += 1) {
    if (PDF_MAGIC.every((byte, index) => bytes[offset + index] === byte)) {
      return true;
    }
  }

  return false;
}

/**
 * PDF 解析 adapter：对子进程解析的薄适配。
 *
 * 后端（当前 pdf-parse + 手写分行）是可替换实现，只要仍产出 ParsedBlock 契约即可，
 * 因此将来换成 Docling / unstructured 时外部契约不变（见设计文档 D8）。
 */
export const PdfParser: DocumentParser = {
  fileType: "pdf",
  contentTypes: ["application/pdf"],
  extensions: ["pdf"],
  accepts(input: ParserInput): boolean {
    return hasPdfMagicBytes(input.content);
  },
  parse(input: ParserInput): ParsedBlock[] {
    if (typeof input.content === "string") {
      throw new Error("PDF 内容应为二进制字节（Uint8Array），不支持字符串入参。");
    }

    return parsePdfBlocks(input.content);
  }
};
