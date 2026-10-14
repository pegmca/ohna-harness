import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestDocument, parsePdfBlocks } from "../dist/index.js";

/**
 * 生成最小合法 PDF（含 2 页，第 1 页含一行表格），确定性、无外部依赖。
 *
 * 用 Buffer 按「字节长度」精确计算 xref 偏移（避免 string.length 在混合编码下的偏差），
 * 保证 pdf.js 能正确解析。每页用 BT/ET + Tj 绘制文本行；第 1 页含一行多列空格分隔的表格行。
 *
 * @returns {Uint8Array} PDF 字节。
 */
function buildMinimalPdf() {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const content1 = "BT /F1 12 Tf 72 720 Td (Revenue   1000   2000) Tj ET\nBT /F1 12 Tf 72 700 Td (Net income 10.5B) Tj ET";
  const content2 = "BT /F1 12 Tf 72 720 Td (Annual Report 2024 page two) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content1, "latin1") + 1} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${Buffer.byteLength(content2, "latin1") + 1} >>\nstream\n${content2}\nendstream`
  ];

  let buf = Buffer.from(header);
  const offsets = [];
  objs.forEach((body, index) => {
    offsets.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]);
  });

  const xrefStart = buf.length;
  // 注意：pdf.js 的 xref 解析对条目 EOL 较严格（正则 n\r?\n），条目必须以 CRLF 结尾，
  // 用 "n \n"（空格+LF）会被判为 bad XRef entry，因此此处统一用 \r\n。
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n`;
  offsets.forEach((offset) => {
    xref += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  });
  buf = Buffer.concat([buf, Buffer.from(xref, "latin1")]);
  buf = Buffer.concat([
    buf,
    Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, "latin1")
  ]);

  return new Uint8Array(buf);
}

const SAMPLE_PDF = buildMinimalPdf();

test("parsePdfBlocks returns page-numbered blocks with a marked table row", () => {
  const blocks = parsePdfBlocks(SAMPLE_PDF);

  assert.ok(blocks.length > 0);
  // 每个 block 都应带页码，来自真实 PDF 结构。
  assert.ok(blocks.every((block) => typeof block.pageNumber === "number"));
  // 至少覆盖两页。
  assert.ok(blocks.some((block) => block.pageNumber === 1));
  assert.ok(blocks.some((block) => block.pageNumber === 2));

  const tableBlock = blocks.find((block) => block.metadata && block.metadata.isTableRow === true);
  assert.ok(tableBlock, "应识别到一个表格行 block");
  assert.equal(tableBlock.metadata.tableColumnCount, 3);
});

test("ingestDocument on PDF no longer returns pdf_parser_not_configured", () => {
  const result = ingestDocument({
    source: "local://annual-report.pdf",
    fileName: "annual-report.pdf",
    contentType: "application/pdf",
    content: SAMPLE_PDF
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.error?.code, "pdf_parser_not_configured");

  const blocks = result.document.blocks;
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every((block) => typeof block.pageNumber === "number"));
  assert.ok(blocks.some((block) => block.metadata && block.metadata.isTableRow === true));
});
