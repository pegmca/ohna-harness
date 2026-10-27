import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 渲染单页图片的输入。 */
export interface RenderPdfPageInput {
  /** PDF 原始字节。 */
  pdf: Uint8Array;
  /** 1-based 页码。 */
  pageNumber: number;
  /** 目标渲染 DPI，默认 110。 */
  dpi?: number;
  /** 可选 pdftoppm 路径；缺省从 PATH 解析。 */
  binary?: string;
}

/**
 * 用 pdftoppm 渲染 PDF 单页为 PNG。
 *
 * 仅渲染明确点名的页面，避免整份财报 PNG 全量落库。
 *
 * @param input PDF 字节、页码和渲染配置。
 * @returns PNG 字节。
 */
export function renderPdfPageToPng(input: RenderPdfPageInput): Uint8Array {
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new Error(`pageNumber 必须是大于 0 的整数：${input.pageNumber}`);
  }

  const dir = mkdtempSync(join(tmpdir(), "rag-page-image-"));
  const pdfPath = join(dir, "input.pdf");
  const outputPrefix = join(dir, "page");
  try {
    writeFileSync(pdfPath, input.pdf);
    execFileSync(input.binary ?? "pdftoppm", [
      "-f",
      String(input.pageNumber),
      "-singlefile",
      "-r",
      String(input.dpi ?? 110),
      "-png",
      pdfPath,
      outputPrefix
    ]);
    return new Uint8Array(readFileSync(`${outputPrefix}.png`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
