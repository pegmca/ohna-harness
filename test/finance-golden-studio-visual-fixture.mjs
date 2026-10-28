/**
 * Finance Golden Studio 视觉检查用真实本地 API。
 *
 * 临时工作区、manifest、PDF、作者集和草稿都在进程退出时清理。
 */
import { createGoldenStudioServer } from "../apps/finance-golden-studio/src/server/http.ts";
import { generateEvalDataset } from "../apps/finance-golden-studio/src/core/generate.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeAnchoredPdf,
  writeGolden,
  writeManifest
} from "../apps/finance-golden-studio/test/workflow-fixtures.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const config = makeWorkflowConfig();
const pdfPath = "600000.SH/annual/2025.pdf";
writeManifest(config, [
  {
    ticker: "600000.SH",
    report_type: "annual",
    period: "2025",
    file_path: pdfPath
  }
]);
writeAnchoredPdf(config, pdfPath);
writeGolden(config, [makeGoldenCase()]);
mkdirSync(config.draftRoot, { recursive: true });
mkdirSync(join(config.draftRoot, "pending-batch"), { recursive: true });
await generateEvalDataset(config);

const server = createGoldenStudioServer(config);
const address = await server.listen(4318, "127.0.0.1");
console.log(`Golden Studio visual API: http://${address.host}:${address.port}`);

const shutdown = async () => {
  await server.close().catch(() => undefined);
  cleanupWorkflowFixtures();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
