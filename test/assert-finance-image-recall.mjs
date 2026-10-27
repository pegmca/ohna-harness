/**
 * D4 image canary 诊断：渲染 fin-014 的 page_image_ref，并验证页面 PNG 可读取。
 *
 * 用法：node test/assert-finance-image-recall.mjs [输出 JSON 路径]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadFinanceDataset } from "../apps/finance-api/dist/eval/dataset.js";
import {
  createInMemoryPageImageRepository,
  ingestPageImage,
  parsePageNumber
} from "../packages/rag/dist/index.js";

const dataset = loadFinanceDataset(resolve("datasets/finance/rag-golden-v1.json"));
const case_ = dataset.cases.find((item) => item.id === "fin-014");
if (!case_) throw new Error("golden 中缺少 fin-014 image canary");
const document = case_.documents[0];
if (!document || document.sourceKind !== "image" || typeof document.pageImageRef !== "string") {
  throw new Error("fin-014 缺少 image sourceKind/pageImageRef");
}
if (!(document.content instanceof Uint8Array)) {
  throw new Error("fin-014 文档必须是 PDF bytes");
}

const pageNumber = parsePageNumber(document.pageImageRef);
const repository = createInMemoryPageImageRepository();
const ingested = await ingestPageImage({
  pdf: document.content,
  source: document.source,
  pageImageRef: document.pageImageRef,
  repository,
  dpi: 40,
  ...(process.env.PDFTOPPM_BIN ? { binary: process.env.PDFTOPPM_BIN } : {})
});
const asset = await repository.get(ingested.documentId, pageNumber);
if (!asset) throw new Error("页面 PNG 未写入 repository");

const result = {
  caseId: case_.id,
  pageImageRef: ingested.pageImageRef,
  pageNumber,
  pngBytes: asset.png.byteLength,
  pngSignature: [...asset.png.subarray(0, 8)]
};
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) {
  writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2), "utf8");
}
