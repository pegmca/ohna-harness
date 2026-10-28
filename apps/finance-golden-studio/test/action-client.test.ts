import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createGoldenStudioServer } from "../src/server/http.ts";
import { createGoldenStudioClient } from "../src/web/shared/api/client.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeAnchoredPdf,
  writeGolden,
  writeManifest
} from "./workflow-fixtures.mjs";

/** 当前集成测试创建的 server。 */
let studioServer: ReturnType<typeof createGoldenStudioServer> | undefined;

after(async () => {
  await studioServer?.close().catch(() => undefined);
  cleanupWorkflowFixtures();
});

test("actual client promotes, mines, and generates with authoritative counts", async () => {
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
  writeGolden(config, []);
  mkdirSync(join(config.draftRoot, "integration-batch"), { recursive: true });

  const approvedDraft = {
    ...makeGoldenCase(),
    id: "fin-D001",
    query: "What was revenue?",
    _draft: { approved: true }
  };
  studioServer = createGoldenStudioServer(config);
  const address = await studioServer.listen(0, "127.0.0.1");
  const client = createGoldenStudioClient(
    `http://127.0.0.1:${address.port}/`
  );

  await client.saveDraft("integration-batch", "fin-D001", approvedDraft);
  const promoted = await client.runAction("promote", {
    batch: "integration-batch"
  });
  const mined = await client.runAction("mine", {
    batch: "mined-batch",
    candidates: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        type: "numeric_fact"
      }
    ]
  });
  const generated = await client.runAction("generate");

  assert.equal(promoted.action, "promote");
  assert.equal(promoted.result.promotedCount, 1);
  assert.equal(mined.action, "mine");
  assert.equal(mined.result.draftedCount, 1);
  assert.equal(mined.result.skippedCount, 0);
  assert.equal(generated.action, "generate");
  assert.equal(generated.result.caseCount, 1);
});
