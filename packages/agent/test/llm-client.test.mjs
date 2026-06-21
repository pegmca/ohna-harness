import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlmClient } from "../dist/index.js";

test("chat sends an OpenAI compatible request and returns normalized content", async () => {
  const seen = {};
  const client = createLlmClient({
    apiKey: "test-key",
    baseUrl: "https://llm.example/v1/",
    model: "test-model",
    fetch: async (url, init) => {
      seen.url = url;
      seen.headers = init.headers;
      seen.body = JSON.parse(init.body);

      return jsonResponse({
        model: "provider-model",
        choices: [{ message: { content: "ROE is return on equity." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
      });
    }
  });

  const result = await client.chat({
    messages: [{ role: "user", content: "Explain ROE." }],
    temperature: 0.2
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.content, "ROE is return on equity.");
  assert.equal(result.data.model, "provider-model");
  assert.deepEqual(result.data.usage, {
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10
  });
  assert.equal(seen.url, "https://llm.example/v1/chat/completions");
  assert.equal(seen.headers.Authorization, "Bearer test-key");
  assert.equal(seen.body.model, "test-model");
  assert.deepEqual(seen.body.messages, [{ role: "user", content: "Explain ROE." }]);
});

test("jsonChat returns structured parse errors instead of throwing", async () => {
  const client = createLlmClient({
    apiKey: "test-key",
    baseUrl: "https://llm.example/v1",
    model: "test-model",
    fetch: async () =>
      jsonResponse({
        choices: [{ message: { content: "not json" }, finish_reason: "stop" }]
      })
  });

  const result = await client.jsonChat({
    schemaName: "financial metric",
    messages: [{ role: "user", content: "Return JSON." }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "json_parse_error");
  assert.match(result.error.message, /financial metric/);
  assert.equal(result.error.details.contentPreview, "not json");
});

test("toolChat returns a normalized tool name and parsed arguments", async () => {
  const client = createLlmClient({
    apiKey: "test-key",
    baseUrl: "https://llm.example/v1",
    model: "test-model",
    fetch: async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "financial_metric_lookup",
                    arguments: JSON.stringify({ ticker: "000001.SZ", metric: "net_income" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      })
  });

  const result = await client.toolChat({
    messages: [{ role: "user", content: "Query latest net income for 000001.SZ." }],
    tools: [
      {
        name: "financial_metric_lookup",
        parameters: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            metric: { type: "string" }
          },
          required: ["ticker", "metric"]
        }
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.toolCall.name, "financial_metric_lookup");
  assert.deepEqual(result.data.toolCall.arguments, {
    ticker: "000001.SZ",
    metric: "net_income"
  });
});

test("chat returns a timeout error when the request is aborted", async () => {
  const client = createLlmClient({
    apiKey: "test-key",
    baseUrl: "https://llm.example/v1",
    model: "test-model",
    timeoutMs: 1,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })
  });

  const result = await client.chat({
    messages: [{ role: "user", content: "Will timeout." }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "request_timeout");
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}
