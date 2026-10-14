import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmbeddingClientFromEnv,
  createOpenAiCompatibleEmbeddingClient
} from "../dist/embedding-providers.js";
import { PROVIDER_ENV } from "../dist/provider-config.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

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

test("createEmbeddingClientFromEnv：embedding 环境变量缺失时返回 null（不再静默回退 mock）", async () => {
  const saved = {};
  for (const key of Object.values(PROVIDER_ENV.embedding)) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  try {
    const client = createEmbeddingClientFromEnv();
    // v1.1：禁用时工厂返回 null，由组合根显式决定降级或阻断，而非偷偷兜底 mock。
    assert.equal(client, null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("createEmbeddingClientFromEnv：model 缺失时保持 disabled", () => {
  const saved = {};
  for (const key of Object.values(PROVIDER_ENV.embedding)) saved[key] = process.env[key];
  process.env[PROVIDER_ENV.embedding.baseUrl] = "http://provider.test/v1";
  process.env[PROVIDER_ENV.embedding.apiKey] = "provider-key";
  delete process.env[PROVIDER_ENV.embedding.model];

  try {
    assert.equal(createEmbeddingClientFromEnv(), null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("createEmbeddingClientFromEnv：独立 embedding env 就绪时返回真实 client", async () => {
  const saved = {};
  for (const key of Object.values(PROVIDER_ENV.embedding)) {
    saved[key] = process.env[key];
  }
  process.env[PROVIDER_ENV.embedding.baseUrl] = "http://provider.test/v1";
  process.env[PROVIDER_ENV.embedding.apiKey] = "provider-key";
  process.env[PROVIDER_ENV.embedding.model] = "provider-embedding-model";
  process.env[PROVIDER_ENV.embedding.dimensions] = "6";
  const restoreFetch = stubFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, "http://provider.test/v1/embeddings");
    assert.equal(body.model, "provider-embedding-model");
    assert.equal(body.dimensions, 6);
    return new Response(JSON.stringify(buildOkPayload(body.input, 6)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  try {
    const client = createEmbeddingClientFromEnv();
    assert.notEqual(client, null);
    const result = await client.embedTexts(["hello"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.model, "provider-embedding-model");
    assert.equal(result.dimensions, 6);
  } finally {
    restoreFetch();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("deterministic mock 仅能通过 testing 模块显式注入", async () => {
  // 直接注入 deterministic mock 测试替身，验证可复现行为（生产工厂已不再自动回退）。
  const client = createDeterministicMockEmbeddingClient();
  const result = await client.embedTexts(["hello"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.model, "deterministic-mock-embedding-v1");
});
