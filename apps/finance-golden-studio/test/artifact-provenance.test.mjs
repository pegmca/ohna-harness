/**
 * Committed 评测产物的 provenance 契约测试。
 *
 * 该文件是历史产物，人工关键词阻塞期间不得被重新生成或伪装为 fresh。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Golden Studio 包根。 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 仓库根。 */
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
/** Committed 评测产物路径。 */
const ARTIFACT_PATH = join(REPO_ROOT, "datasets", "finance", "rag-golden-v1.json");

test("committed artifact 保留历史 generator 并明确标记 blocked/stale", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));

  assert.deepEqual(
    {
      generator: artifact.generatedBy?.generator,
      version: artifact.generatedBy?.version,
      source: artifact.generatedBy?.source,
      status: artifact.generatedBy?.status
    },
    {
      generator: "test/generate-finance-golden-v1.mjs",
      version: "1.0.0",
      source: "datasets/finance/rag-golden/golden.jsonl",
      status: "blocked"
    }
  );
  assert.match(artifact.generatedBy?.note ?? "", /35/u);
  assert.match(artifact.generatedBy?.note ?? "", /人工|human/iu);
  assert.match(artifact.generatedBy?.note ?? "", /stale|blocked/u);
});
