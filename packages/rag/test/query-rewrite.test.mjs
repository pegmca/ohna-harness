import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLlmQueryRewriter,
  createNoopQueryRewriter,
  createQueryRewriter
} from "../dist/query-rewrite.js";

test("createQueryRewriter uses injected rewrite and surfaces rewritten + subQueries", async () => {
  const rewrite = async (query) => ({
    rewritten: `${query}（扩展问句）`,
    subQueries: ["子问题一", "子问题二"]
  });
  const rewriter = createQueryRewriter({ rewrite });

  const result = await rewriter("平安银行不良率");

  assert.equal(result.rewritten, "平安银行不良率（扩展问句）");
  assert.deepEqual(result.subQueries, ["子问题一", "子问题二"]);
});

test("createNoopQueryRewriter returns the original query unchanged", async () => {
  const rewriter = createNoopQueryRewriter();
  const result = await rewriter("宁德时代毛利率");

  assert.equal(result.rewritten, "宁德时代毛利率");
  assert.equal(result.subQueries, undefined);
});

test("createQueryRewriter downgrades to original query when rewrite throws", async () => {
  const rewrite = async () => {
    throw new Error("llm unavailable");
  };
  const rewriter = createQueryRewriter({ rewrite });

  const result = await rewriter("招商银行拨备覆盖率");

  assert.equal(result.rewritten, "招商银行拨备覆盖率");
});

test("createQueryRewriter downgrades to original query when rewrite returns empty rewritten", async () => {
  const rewrite = async () => ({ rewritten: "   " });
  const rewriter = createQueryRewriter({ rewrite });

  const result = await rewriter("原始问题");

  assert.equal(result.rewritten, "原始问题");
});

test("createLlmQueryRewriter parses JSON from the bridge chat response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              rewritten: "改写后的检索问句",
              subQueries: ["子问题A", "子问题B"]
            })
          }
        }
      ]
    })
  });

  try {
    const rewriter = createLlmQueryRewriter({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await rewriter("新能源渗透率");

    assert.equal(result.rewritten, "改写后的检索问句");
    assert.deepEqual(result.subQueries, ["子问题A", "子问题B"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createLlmQueryRewriter downgrades to original query when bridge returns non-ok", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  try {
    const rewriter = createLlmQueryRewriter({
      baseUrl: "https://bridge.example.com/v1",
      apiKey: "test-key",
      model: "hy3-x"
    });
    const result = await rewriter("新能源渗透率");

    assert.equal(result.rewritten, "新能源渗透率");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
