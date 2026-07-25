import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTraceRecorder, createInMemoryTraceStore } from "../dist/index.js";

const base = (recorder, type, id, extra = {}) => ({ type, id, traceId: recorder.traceId, requestId: recorder.requestId, createdAt: new Date().toISOString(), ...extra });

test("aggregates known usage and preserves unknown token state", () => {
  const recorder = createInMemoryTraceRecorder("trace_1", "req_1");
  recorder.record(base(recorder, "model_call", "m1", { model: "a", purpose: "chat", durationMs: 5, ok: true, usage: { promptTokens: 10, completionTokens: 4 } }));
  recorder.record(base(recorder, "model_call", "m2", { model: "b", purpose: "route", durationMs: 2, ok: true }));
  recorder.record(base(recorder, "final_response", "f1", { answerPreview: "ok", ok: true }));
  const summary = recorder.getTrace().summary;
  assert.deepEqual({ ...summary, durationMs: 0 }, { status: "succeeded", durationMs: 0, modelCallCount: 2, toolCallCount: 0, retrievalCount: 0, inputTokens: "unknown", outputTokens: "unknown", knownTokenTotal: 14, unknownTokenCallCount: 1, errorCount: 0 });
});

test("redacts nested keys, secrets in text and truncates payloads", () => {
  const recorder = createInMemoryTraceRecorder("trace_2", "req_2");
  recorder.record(base(recorder, "tool_call", "t1", { toolName: "x", args: { authorization: "Bearer abc", note: `Bearer secret-token ${"x".repeat(600)}` }, durationMs: 1, ok: false, error: { code: "timeout", message: "Bearer hidden-token", details: { apiKey: "sk-secretsecretsecret" } } }));
  const serialized = JSON.stringify(recorder.getTrace());
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secretsecretsecret"), false);
  assert.equal(serialized.includes("[truncated]"), true);
  assert.equal(recorder.getTrace().summary.errorCount, 1);
  assert.equal(recorder.getTrace().events[0].error.stage, "tool_call");
});

test("stores and retrieves a trace by requestId without sharing mutation", async () => {
  const recorder = createInMemoryTraceRecorder("trace_3", "req_3");
  const store = createInMemoryTraceStore();
  const context = {
    userId: "user_1", runId: "run_1", conversationId: "conversation_1",
    traceId: "trace_3", requestId: "req_3", startedAt: new Date().toISOString()
  };
  await store.initialize(context);
  await store.finalize(context, recorder.getTrace());
  const found = await store.getByRequestId("user_1", "req_3");
  assert.equal(found?.traceId, "trace_3");
  found.events.push({});
  assert.equal((await store.getByRequestId("user_1", "req_3")).events.length, 0);
  assert.equal(await store.getByRequestId("user_2", "req_3"), undefined);
});

test("redacts PII classes from nested trace payloads", () => {
  const recorder = createInMemoryTraceRecorder("trace_pii", "req_pii");
  recorder.record(base(recorder, "final_response", "pii", { answerPreview: "a@example.com 13812345678 11010519491231002X 6222 0201 2345 6789 012", ok: true }));
  const serialized = JSON.stringify(recorder.getTrace());
  for (const secret of ["a@example.com", "13812345678", "11010519491231002X", "6222 0201 2345 6789 012"]) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /redacted:email/);
});
