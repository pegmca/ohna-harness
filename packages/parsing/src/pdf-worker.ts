/**
 * PDF 解析子进程源码（ESM）。
 *
 * 为什么用子进程而不是在主线程直接 require('pdf-parse')：
 * pdf-parse（及其底层 pdf.js）的解析是异步且较重的 CPU/内存操作；而本包的
 * ingestDocument 边界目前是同步契约（rag 的 data-source-runtime 同步调用它）。
 * 为了让 ingestion 边界保持同步、同时复用真实的异步 PDF 解析依赖，这里把解析放到
 * 一个独立 Node 子进程中执行，并通过 execFileSync 同步回收结果。这样既不改动
 * rag runtime 的调用约定，也把解析失败收敛为结构化错误而非进程级异常。
 *
 * 子进程逐页用 getTextContent 抽取文本，并按文本 y 坐标（transform[5]）把同一行的
 * 字符聚合为行，从而保留"行"结构，便于上层做表格行识别与 pageNumber 标注。
 *
 * 该文件只承载子进程源码字符串；调用与结果映射在 parsers/pdf.ts 中。
 */
export const PDF_WORKER_SOURCE = [
  `import { readFileSync } from "node:fs";`,
  `const pdfPath = process.env.PARSING_PDF_PATH;`,
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
