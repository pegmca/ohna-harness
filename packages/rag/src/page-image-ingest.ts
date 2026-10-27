import { createHash } from "node:crypto";
import type { PageImageRepository } from "./page-image-repository.js";
import { renderPdfPageToPng } from "./page-image-render.js";

/** 图片型财报页面 ingestion 输入。 */
export interface IngestPageImageInput {
  /** PDF 原始字节。 */
  pdf: Uint8Array;
  /** 来源标识。 */
  source: string;
  /** 页面引用，形如 `<source>#page=N`。 */
  pageImageRef: string;
  /** 页面图片仓储。 */
  repository: PageImageRepository;
  /** 可选渲染 DPI。 */
  dpi?: number;
  /** 可选 pdftoppm 路径。 */
  binary?: string;
}

/**
 * 为图片型来源渲染单页 PNG 并写入文档级仓储。
 *
 * @param input PDF 字节、页面引用与仓储。
 * @returns 页面引用、文档 ID 和渲染页数。
 */
export async function ingestPageImage(input: IngestPageImageInput): Promise<{
  documentId: string;
  pageImageRef: string;
  pageCount: 1;
}> {
  const pageNumber = parsePageNumber(input.pageImageRef);
  const documentId = `document_${createHash("sha256").update(input.source).digest("hex").slice(0, 16)}`;
  const png = renderPdfPageToPng({
    pdf: input.pdf,
    pageNumber,
    ...(input.dpi !== undefined ? { dpi: input.dpi } : {}),
    ...(input.binary !== undefined ? { binary: input.binary } : {})
  });
  await input.repository.put({
    documentId,
    pageNumber,
    png,
    source: input.source
  });

  return {
    documentId,
    pageImageRef: input.repository.createPageImageRef(documentId, pageNumber),
    pageCount: 1
  };
}

/**
 * 从 `<source>#page=N` 中解析 1-based 页码。
 *
 * @param pageImageRef 页面引用。
 * @returns 页码。
 */
export function parsePageNumber(pageImageRef: string): number {
  const match = /#page=(\d+)$/.exec(pageImageRef);
  const pageNumber = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error(`pageImageRef 缺少合法 #page=N：${pageImageRef}`);
  }
  return pageNumber;
}
