import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmbeddingClientFromEnv,
  createOpenAiCompatibleEmbeddingClient
} from "../dist/embedding-providers.js";

/**
 * 构造一个标准 OpenAI 兼容的 embeddings 响应体。
 */
function buildOkPayload(texts, dimensions) {
  return {
    object: "list",
    data: texts.map((text, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dimensions }, (_, i) => (i + 1) * 0.01)
    })),
    model: "test-embedding-model",
    usage: { prompt_tokens: 10, total_tokens: 10 }
  };
}

/**
 * 用给定实现替换全局 fetch，返回恢复函数。
 */
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

test("真实 client：正常响应映射到 EmbeddingResult.ok", async () => {
  const dimensions = 8;
  const texts = ["hello", "world", "foo"];
  const restore = stubFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    // 校验请求契约：POST、Bearer 鉴权、model/input/dimensions 齐备。
    assert.equal(url, "http://bridge.test/v1/embeddings");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(body.model, "test-embedding-model");
    assert.deepEqual(body.input, texts);
    assert.equal(body.dimensions, dimensions);
    return new Response(JSON.stringify(buildOkPayload(texts, dimensions)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "test-embedding-model",
      dimensions
    });
    const result = await client.embedTexts(texts);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.embeddings.length, texts.length);
    assert.equal(result.model, "test-embedding-model");
    assert.equal(result.dimensions, dimensions);
    for (const item of result.embeddings) {
      assert.equal(item.vector.length, dimensions);
      assert.equal(item.text, texts[item.index]);
    }
    assert.equal(result.usage.inputTexts, texts.length);
  } finally {
    restore();
  }
});

test("真实 client：HTTP 500 返回 embedding_failed", async () => {
  const restore = stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "m",
      dimensions: 4
    });
    const result = await client.embedTexts(["x"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "embedding_failed");
    assert.equal(result.error.details.status, 500);
  } finally {
    restore();
  }
});

test("真实 client：fetch 抛异常返回 embedding_failed", async () => {
  const restore = stubFetch(async () => {
    throw new Error("connection refused");
  });
  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "m",
      dimensions: 4
    });
    const result = await client.embedTexts(["x"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "embedding_failed");
  } finally {
    restore();
  }
});

test("真实 client：空输入安全返回 ok 空 embeddings", async () => {
  // 空输入不应发起网络请求。
  const restore = stubFetch(async () => {
    throw new Error("不应被调用");
  });
  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "m",
      dimensions: 4
    });
    const result = await client.embedTexts([]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.embeddings, []);
  } finally {
    restore();
  }
});

test("真实 client：dimensions<=0 返回 invalid_embedding_input", async () => {
  const restore = stubFetch(async () => {
    throw new Error("不应被调用");
  });
  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "m",
      dimensions: 0
    });
    const result = await client.embedTexts(["x"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_embedding_input");
  } finally {
    restore();
  }
});

test("真实 client：响应 data 缺失返回 embedding_failed", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
  try {
    const client = createOpenAiCompatibleEmbeddingClient({
      baseUrl: "http://bridge.test/v1",
      apiKey: "test-key",
      model: "m",
      dimensions: 4
    });
    const result = await client.embedTexts(["x"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "embedding_failed");
  } finally {
    restore();
  }
});

test("createEmbeddingClientFromEnv：bridge 环境变量缺失时回退 mock", async () => {
  const original = {
    baseUrl: process.env["AIAGENT_LLM_BASE_URL_BRIDGE_AI"],
    apiKey: process.env["AIAGENT_LLM_API_KEY_BRIDGE_AI"]
  };
  delete process.env["AIAGENT_LLM_BASE_URL_BRIDGE_AI"];
  delete process.env["AIAGENT_LLM_API_KEY_BRIDGE_AI"];

  try {
    const client = createEmbeddingClientFromEnv();
    // mock client 成功对空/非空输入产出 ok 结果。
    const result = await client.embedTexts(["hello"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.model, "deterministic-mock-embedding-v1");
  } finally {
    if (original.baseUrl !== undefined) {
      process.env["AIAGENT_LLM_BASE_URL_BRIDGE_AI"] = original.baseUrl;
    }
    if (original.apiKey !== undefined) {
      process.env["AIAGENT_LLM_API_KEY_BRIDGE_AI"] = original.apiKey;
    }
  }
});
