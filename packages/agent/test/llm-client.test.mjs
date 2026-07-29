import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { chatWithReliability, createLlmClient, createLlmClientForProfile } from "../dist/index.js";

test("named model directory profiles never fall back to generic provider configuration", () => {
  const result = createLlmClientForProfile("deepseek", {
    AIAGENT_LLM_API_KEY: "generic-key",
    AIAGENT_LLM_BASE_URL: "https://generic.example/v1",
    AIAGENT_LLM_MODEL: "generic-model",
    AIAGENT_LLM_API_KEY_DEEPSEEK: undefined,
    AIAGENT_LLM_BASE_URL_DEEPSEEK: undefined,
    AIAGENT_LLM_MODEL_DEEPSEEK: undefined
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "configuration_error");
  assert.match(result.error.message, /deepseek/);
});

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

test("reliable model retries transient errors then uses compatible fallback", async () => {
  let primaryCalls = 0;
  const client = (handler) => ({ chat: handler, streamChat: handler, jsonChat: handler, toolChat: handler });
  const result = await chatWithReliability({ messages: [{ role: "user", content: "test" }] }, {
    primary: { name: "primary", capabilities: { structuredOutput: true, toolCalling: true }, client: client(async () => { primaryCalls += 1; return { ok: false, error: { code: "provider_error", message: "busy", details: { status: 503 } } }; }) },
    fallbacks: [{ name: "fallback", capabilities: { structuredOutput: true, toolCalling: true }, client: client(async () => ({ ok: true, data: { content: "degraded", model: "fallback" } })) }],
    requiredCapabilities: { structuredOutput: true }, retry: { maxAttempts: 2, jitterRatio: 0 }, sleep: async () => undefined
  });
  assert.equal(result.ok, true); assert.equal(primaryCalls, 2); assert.equal(result.degraded, true); assert.equal(result.attempts, 3); assert.match(result.fallbackReason, /provider_error/);
});

test("permanent model errors do not retry", async () => {
  let calls = 0;
  const handler = async () => { calls += 1; return { ok: false, error: { code: "configuration_error", message: "bad key" } }; };
  const client = { chat: handler, streamChat: handler, jsonChat: handler, toolChat: handler };
  const result = await chatWithReliability({ messages: [] }, { primary: { name: "primary", capabilities: { structuredOutput: true, toolCalling: true }, client }, sleep: async () => undefined });
  assert.equal(result.ok, false); assert.equal(calls, 1);
});

test("reliable model preserves the client timeout when no request deadline is provided", async () => {
  let seenTimeout;
  const handler = async (request) => {
    seenTimeout = request.timeoutMs;
    return { ok: true, data: { content: "ok", model: "primary" } };
  };
  const client = { chat: handler, streamChat: handler, jsonChat: handler, toolChat: handler };
  const result = await chatWithReliability(
    { messages: [{ role: "user", content: "test" }] },
    { primary: { name: "primary", capabilities: { structuredOutput: true, toolCalling: true }, client } }
  );

  assert.equal(result.ok, true);
  assert.equal(seenTimeout, undefined);
});

test("reliable model returns structured retry exhaustion", async () => {
  let calls = 0;
  const handler = async () => { calls += 1; return { ok: false, error: { code: "network_error", message: "offline" } }; };
  const client = { chat: handler, streamChat: handler, jsonChat: handler, toolChat: handler };
  const result = await chatWithReliability({ messages: [] }, { primary: { name: "primary", capabilities: { structuredOutput: true, toolCalling: true }, client }, retry: { maxAttempts: 2 }, sleep: async () => undefined });
  assert.equal(result.ok, false); assert.equal(calls, 2); assert.equal(result.error.details.retryExhausted, true); assert.equal(result.attempts, 2);
});

test("jsonChat returns structured parse errors instead of throwing", async () => {
  const trace = createInMemoryTraceRecorder("trace_llm_json_test", "req_llm_json_test");
  const client = createLlmClient({
    apiKey: "test-key",
    baseUrl: "https://llm.example/v1",
    model: "test-model",
    traceRecorder: trace,
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

  const [event] = trace.getEvents();
  assert.equal(event.type, "model_call");
  assert.equal(event.requestId, "req_llm_json_test");
  assert.equal(event.purpose, "json_chat");
  assert.equal(event.ok, false);
  assert.equal(event.error.code, "json_parse_error");
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
