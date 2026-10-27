/**
 * runtime 组合根冒烟测试。
 *
 * 覆盖计划 Task 5 的三个强制场景：health/ok + protocolVersion、modelCatalog 注入回显、
 * shutdown 可重复调用不抛错。真实 run 执行与订阅在 Task 9 接通。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOhnaRuntime } from "../dist/index.js";

/** 最小可用模型：仅取 runtime 组合根需要的字段。 */
function makeModel() {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048
  };
}

/** 临时数据目录，测试后清理（await 内部逻辑，避免 finally 抢删未完成的异步写入）。 */
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ohna-runtime-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const modelCatalog = {
  defaultModelId: "test-model",
  models: [
    {
      id: "test-model",
      label: "Test Model",
      provider: "mock",
      description: "test",
      isDefault: true,
      capabilities: { structuredOutput: true, toolCalling: true },
      contextWindow: 8192,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
  ]
};

let runtime;
await withTmpDir(async (dir) => {
  runtime = await createOhnaRuntime({
    dataDir: dir,
    model: makeModel(),
    apiKey: "k",
    tools: [],
    autoApprove: true,
    modelCatalog
  });
  // 校验完成后再释放锁与临时目录（锁在 createOhnaRuntime 内获取）。
  await runtime.shutdown();
});

const health = await runtime.getHealth();
assert.equal(health.status, "ok");
assert.equal(health.protocolVersion, 1);
assert.equal(health.modelCount, 1);

const catalog = await runtime.getModelCatalog();
assert.equal(catalog.defaultModelId, "test-model");
assert.equal(catalog.models.length, 1);

// shutdown 必须幂等：重复调用不抛错。
await runtime.shutdown();
await runtime.shutdown();
