import assert from "node:assert/strict";
import test from "node:test";

import { createProxyAwareFetch, resolveProxyUrl } from "../dist/api/openai-completions/proxy-fetch.js";

test("resolveProxyUrl：优先 AIAGENT_HTTP_PROXY，空值回退标准变量", () => {
  assert.equal(
    resolveProxyUrl({ AIAGENT_HTTP_PROXY: "http://127.0.0.1:1082" }),
    "http://127.0.0.1:1082"
  );
  assert.equal(
    resolveProxyUrl({ AIAGENT_HTTP_PROXY: "  ", HTTPS_PROXY: "http://proxy.local:8080" }),
    "http://proxy.local:8080"
  );
  assert.equal(resolveProxyUrl({}), undefined);
});

test("createProxyAwareFetch：未配置代理时复用全局 fetch", () => {
  assert.equal(createProxyAwareFetch({}), globalThis.fetch);
});
