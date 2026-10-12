import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 解析阶段的 block 草稿保留 heading 和行号，最终会补齐稳定 id 后进入 DTO。
 */
export interface FilingParsedBlock {
  text: string;
  heading?: string;
  lineStart: number;
  lineEnd: number;
  /** PDF 等带页码来源会保留页码，供后续 chunk / citation 标注原文位置。 */
  pageNumber?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * PDF 解析子进程源码（ESM）。
 *
 * 为什么用子进程而不是在主线程直接 require('pdf-parse')：
 * pdf-parse（及其底层 pdf.js）的解析是异步且较重的 CPU/内存操作；而本包的
 * ingestFiling 边界目前是同步契约（rag 的 data-source-runtime 同步调用它）。
 * 为了让 ingestion 边界保持同步、同时复用真实的异步 PDF 解析依赖，这里把解析放到
 * 一个独立 Node 子进程中执行，并通过 execFileSync 同步回收结果。这样既不改动
 * rag runtime 的调用约定，也把解析失败收敛为结构化错误而非进程级异常。
 *
 * 子进程逐页用 getTextContent 抽取文本，并按文本 y 坐标（transform[5]）把同一行的
 * 字符聚合为行，从而保留"行"结构，便于上层做表格行识别与 pageNumber 标注。
 */
const PDF_WORKER_SOURCE = [
  `import { readFileSync } from "node:fs";`,
  `const pdfPath = process.env.FILING_PDF_PATH;`,
  `const pdfParsePath = process.env.PDF_PARSE_PATH;`,
  `const pdfParse = (await import(pdfParsePath)).default;`,
  `// Node 的 readFileSync 返回的是共享缓冲池（pool）中的 Buffer，其 byteOffset 通常非 0。`,
  `// pdf.js v1.10.100 的 makeSubStream 会直接读取底层 ArrayBuffer 而忽略 byteOffset，`,
  `// 从而读到缓冲池里相邻的无关内存（表现为 bad XRef entry / Invalid PDF structure）。`,
  `// 因此必须把读到的 Buffer 重新封装为「独立拥有底层 ArrayBuffer、byteOffset 为 0」的 Uint8Array，`,
  `// 让 pdf.js 始终从正确的字节位置开始解析。`,
  `const rawBuf = readFileSync(pdfPath);`,
  `const pdfBytes = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);`,
  `const pages = [];`,
  `const pagerender = (pageData) => pageData.getTextContent().then((content) => {`,
  `  const rows = {};`,
  `  for (const it of content.items) {`,
  `    if (it.str === undefined) continue;`,
  `    const y = Math.round(it.transform[5]);`,
  `    if (!rows[y]) rows[y] = [];`,
  `    rows[y].push(it.str);`,
  `  }`,
  `  const lines = Object.keys(rows).map(Number).sort((a, b) => b - a).map((y) => rows[y].join(" "));`,
  `  const pageText = lines.join("\\n");`,
  `  pages.push(pageText);`,
  `  return pageText;`,
  `});`,
  `const result = await pdfParse(pdfBytes, { pagerender: pagerender });`,
  `process.stdout.write(JSON.stringify({ pages: pages, numpages: result.numpages }));`
].join("\n");

/**
 * 解析 PDF 二进制内容为带 pageNumber 与表格标记的 block 草稿。
 *
 * WHY：PDF 是公告/财报的高频来源，但原生异步解析不能直接塞进同步 ingestion 边界，
 * 因此交给子进程同步回收（见 PDF_WORKER_SOURCE）。每个 page 的文本按行切分，
 * 表格行被单独标记为 block.metadata.isTableRow，便于 RAG chunk 与 citation 保留
 * "第几页/第几行/是否表格"的精准位置线索。
 *
 * @param content PDF 原始字节。
 * @returns 带 pageNumber 与表格标记的解析 block 草稿；解析失败向上抛出，由 ingestFiling 收敛为结构化错误。
 */
export function parsePdfBlocks(content: Uint8Array): FilingParsedBlock[] {
  // 解析依赖在运行时才需要：这里只做路径解析，未安装时抛出可被上层捕获的明确错误。
  const require = createRequire(import.meta.url);
  let pdfParsePath: string;

  try {
    pdfParsePath = require.resolve("pdf-parse");
  } catch {
    throw new Error("pdf-parse 未安装：请先执行 pnpm install 注入 PDF 解析依赖。");
  }

  const dir = mkdtempSync(join(tmpdir(), "filing-pdf-"));
  const pdfPath = join(dir, "input.pdf");
  writeFileSync(pdfPath, content);

  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", PDF_WORKER_SOURCE], {
      env: { ...process.env, FILING_PDF_PATH: pdfPath, PDF_PARSE_PATH: pdfParsePath },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000
    });
    const parsed = JSON.parse(out.toString("utf-8")) as { pages: string[]; numpages: number };

    return buildPdfBlocks(parsed.pages);
  } finally {
    // 无论成功失败都清理临时 PDF，避免磁盘泄漏。
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把子进程返回的逐页文本转换为 FilingParsedBlock[]。
 *
 * 逐页处理：每页文本按行切分，连续非表格行聚合成段落 block，表格行单独成块并打标。
 * 这样 pageNumber 与行号都来自真实 PDF 结构，chunk/citation 才能溯源到具体页与行。
 *
 * @param pages 子进程解析出的逐页纯文本（已按 y 坐标切好行）。
 * @returns 带 pageNumber 与表格标记的解析 block 草稿。
 */
export function buildPdfBlocks(pages: string[]): FilingParsedBlock[] {
  const blocks: FilingParsedBlock[] = [];

  pages.forEach((pageText, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const lines = splitLines(pageText);
    let paragraphLines: string[] = [];
    let paragraphStart = 0;

    const flushParagraph = (): void => {
      if (paragraphLines.length === 0) {
        return;
      }

      const text = paragraphLines.join("\n").trim();

      if (text.length > 0) {
        blocks.push({
          text,
          pageNumber,
          lineStart: paragraphStart,
          lineEnd: paragraphStart + paragraphLines.length - 1
        });
      }

      paragraphLines = [];
      paragraphStart = 0;
    };

    lines.forEach((line, index) => {
      const lineNumber = index + 1;

      if (line.trim().length === 0) {
        flushParagraph();
        return;
      }

      // 表格行单独成块并打标，避免与相邻正文段落混在同一 block。
      if (isTableRow(line)) {
        flushParagraph();
        blocks.push({
          text: line.trim(),
          pageNumber,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          metadata: {
            isTableRow: true,
            tableColumnCount: countTableColumns(line)
          }
        });
        return;
      }

      if (paragraphLines.length === 0) {
        paragraphStart = lineNumber;
      }

      paragraphLines.push(line);
    });

    flushParagraph();
  });

  return blocks;
}

/**
 * 识别"表格行"：多列分隔特征——制表符、markdown 竖线，或连续多个空格形成至少两处列间隔。
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

  // 连续多个空格且至少出现两处"非空白-空格-非空白"的列间隔，才判定为多列表格。
  const gaps = line.match(/\S\s{2,}\S/g);

  return gaps !== null && gaps.length >= 2;
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

  return line.split(/\s{2,}/).filter((cell) => cell.trim().length > 0).length;
}

/**
 * 按平台无关方式拆分文本行，并去掉末尾由最后一个换行产生的空行。
 *
 * 放在 pdf.ts 中定义并导出，index.ts 与 buildPdfBlocks 共用同一实现，
 * 避免 pdf.ts 反向 import 任何 index.ts 中的值（保持单向依赖 index.ts → pdf.ts）。
 *
 * @param content 原始文本。
 * @returns 文本行数组。
 */
export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  if (lines.at(-1) === "") {
    return lines.slice(0, -1);
  }

  return lines;
}
