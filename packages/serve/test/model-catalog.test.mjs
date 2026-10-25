/**
 * W2（docs/v2.0/04 §5.6）· 模型目录的窗口与费率投影验收。
 *
 * 契约：
 * - `ModelOptionDto` 新增 `contextWindow / maxTokens / cost{input,output,cacheRead,cacheWrite}`；
 * - 数据**全部**来自 `RouteDeps["model"]`（零新增数据来源）；
 * - mock / bridge 模型费率缺失或全 0 时按 0 下发（四字段必填，UI 不判空）；
 * - Trace 不读 `/api/models`：该通道只服务设置弹窗 / 模型选择器（本测试只断言投影，不涉及 Trace）。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";

/**
 * 构造模型元数据。
 *
 * @param {object} [patch] 覆盖字段。
 * @returns {object} Model。
 */
function makeModel(patch = {}) {
  return {
    id: "priced-model",
    name: "Priced Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "http://127.0.0.1/mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...patch
  };
}

/**
 * 最小文本流（目录断言不需要任何 LLM 行为，只避免装配期缺失）。
 *
 * @returns {Function} StreamFn。
 */
function createTextStream() {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
}

/**
 * 用给定模型起一个隔离服务并读取 `/api/models`。
 *
 * @param {object} model 模型。
 * @returns {Promise<{data: object, dispose: Function}>} 目录数据与清理函数。
 */
async function readCatalog(model) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-models-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir: path.join(root, "data"),
    model,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn: createTextStream()
  });
  const response = await server.app.inject({ method: "GET", url: "/api/models" });
  assert.equal(response.statusCode, 200);
  return {
    data: response.json().data,
    async dispose() {
      await server.shutdown();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test("[v2.0] /api/models 下发窗口与费率（字段名冻结）", async () => {
  const model = makeModel();
  const { data, dispose } = await readCatalog(model);
  try {
    assert.equal(data.defaultModelId, model.id);
    const option = data.models.find((item) => item.id === model.id);
    assert.ok(option);
    assert.equal(option.contextWindow, 128_000);
    assert.equal(option.maxTokens, 8_192);
    assert.deepEqual(option.cost, { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 });
    // 窗口与采集层同源：llm_call.window.contextWindow 用的就是这里的值（单一数据来源）。
    assert.equal(option.cost.input, model.cost.input);
  } finally {
    await dispose();
  }
});

test("[v2.0] 费率缺失 / 非有限值按 0 下发（mock / bridge 模型）", async () => {
  const cases = [
    { id: "missing-cost", cost: undefined },
    { id: "partial-cost", cost: { input: 0.5 } },
    { id: "nan-cost", cost: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheRead: 0.1, cacheWrite: -0 } }
  ];
  for (const item of cases) {
    const { data, dispose } = await readCatalog(makeModel({ id: item.id, cost: item.cost }));
    try {
      const option = data.models.find((entry) => entry.id === item.id);
      assert.ok(option);
      // 四字段必填：UI 不需要判空分支。
      assert.deepEqual(Object.keys(option.cost).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
      for (const value of Object.values(option.cost)) {
        assert.equal(typeof value, "number");
        assert.ok(Number.isFinite(value), `${item.id} 的费率必须是有限数`);
      }
    } finally {
      await dispose();
    }
  }
});
