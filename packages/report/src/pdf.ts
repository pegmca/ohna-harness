import type { ResearchReportPdfInput } from "./workflow-types.js";

/**
 * 生成不依赖浏览器的最小合法 PDF。renderer 只接收报告内容，不接触文件路径，
 * 因而 artifact store 可以独立决定 ID、权限和下载策略。
 *
 * @param input 已验证的报告标题、正文和引用。
 * @returns 以 `%PDF-1.4` 开头、可由标准 reader 打开的二进制内容。
 */
export function renderResearchReportPdf(input: ResearchReportPdfInput): Uint8Array {
  const bodyLines = input.markdown
    .replace(/```[\s\S]*?```/g, "[code block]")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/[*_`|]/g, " ").trim())
    .filter(Boolean);
  const lines = [
    `IMMERSIVE FINANCIAL RESEARCH REPORT`,
    `Title: ${toPdfAscii(input.title)}`,
    `Generated: ${toPdfAscii(input.generatedAt)}`,
    "Core sections",
    ...bodyLines.map(toPdfAscii),
    "Sources and citations",
    ...input.citations.map((citation, index) =>
      `[${index + 1}] ${toPdfAscii(citation.source)} - ${toPdfAscii(citation.quote)}`
    )
  ];
  const pages = paginatePdfLines(lines, 44);
  const objects: string[] = [];
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  const fontObjectId = 3 + pages.length * 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const stream = createPdfTextStream(page);
    objects.push(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return assemblePdf(objects);
}

/** @param value 原始文本。 @returns 内置 Helvetica 可稳定显示的 ASCII 文本。 */
function toPdfAscii(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  return normalized || "[non-Latin text; see HTML artifact]";
}

/** @param lines 所有行。 @param pageSize 每页行数。 @returns 分页后的文本。 */
function paginatePdfLines(lines: string[], pageSize: number): string[][] {
  const wrapped = lines.flatMap((line) => line.match(/.{1,88}(?:\s|$)|.{1,88}/g)?.map((part) => part.trim()) ?? [line]);
  const pages: string[][] = [];
  for (let index = 0; index < wrapped.length; index += pageSize) pages.push(wrapped.slice(index, index + pageSize));
  return pages.length ? pages : [["Empty report"]];
}

/** @param lines 当前页文本。 @returns PDF content stream。 */
function createPdfTextStream(lines: string[]): string {
  const commands = lines.map((line, index) => `${index ? "0 -17 Td " : ""}(${line.replace(/([\\()])/g, "\\$1")}) Tj`);
  return `BT\n/F1 10 Tf\n50 790 Td\n${commands.join("\n")}\nET`;
}

/** @param objects PDF indirect objects。 @returns 带 xref/trailer 的完整 PDF。 */
function assemblePdf(objects: string[]): Uint8Array {
  const encoder = new TextEncoder();
  let output = "%PDF-1.4\n%IMMERSIVE\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(output).length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(output).length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(output);
}
