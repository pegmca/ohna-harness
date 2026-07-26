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
  recorder.record(base(recorder, "tool_call", "t1", {
    toolName: "x",
    args: {
      authorization: "Bearer abc",
      session: "raw-session-value",
      sessionId: "raw-session-id",
      aiagent_session: "raw-aiagent-session",
      cookieHeader: "aiagent_session=raw-cookie-session; theme=dark",
      note: `Cookie: aiagent_session=raw-text-cookie; theme=dark\nBearer secret-token ${"x".repeat(600)}`
    },
    durationMs: 1,
    ok: false,
    error: { code: "timeout", message: "Bearer hidden-token", details: { apiKey: "sk-secretsecretsecret" } }
  }));
  const serialized = JSON.stringify(recorder.getTrace());
  for (const secret of [
    "secret-token", "secretsecretsecret", "raw-session-value", "raw-session-id",
    "raw-aiagent-session", "raw-cookie-session", "raw-text-cookie"
  ]) assert.equal(serialized.includes(secret), false);
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

test("finalize 不脱敏 requestId 等身份字段，含长数字串时仍可按键读回", async () => {
  // 回归：sha256 派生的 requestId 可能含 16-19 位连续数字，命中银行卡号正则；
  // finalize 曾整体 sanitize 导致 requestId 被改成 "[redacted:account]"，按键读取契约被破坏。
  const requestId = "req_c7ddfe914af4dc1fdea281afb3683109214924225f4a71140ad6297fea47fe1f";
  const recorder = createInMemoryTraceRecorder("trace_digits", requestId);
  const store = createInMemoryTraceStore();
  const context = {
    userId: "user_digits", runId: "run_digits", conversationId: "conversation_digits",
    traceId: recorder.traceId, requestId, startedAt: new Date().toISOString()
  };
  await store.initialize(context);
  await store.finalize(context, recorder.getTrace());
  const found = await store.getByRequestId("user_digits", requestId);
  assert.equal(found?.requestId, requestId);
});

test("incremental event query keeps partial events separate from the complete trace summary", async () => {
  const recorder = createInMemoryTraceRecorder("trace_cursor", "req_cursor");
  const store = createInMemoryTraceStore();
  const context = {
    userId: "user_cursor", runId: "run_cursor", conversationId: "conversation_cursor",
    traceId: recorder.traceId, requestId: recorder.requestId, startedAt: new Date().toISOString()
  };
  await store.initialize(context);
  for (let index = 0; index < 3; index += 1) {
    const event = base(recorder, "tool_call", `cursor-${index}`, {
      toolName: "search", args: {}, durationMs: index, ok: true
    });
    recorder.record(event);
    await store.append(context, event);
  }
  await store.finalize(context, recorder.getTrace());
  const complete = await store.getByRequestId(context.userId, context.requestId);
  const incremental = await store.listEvents(context.userId, context.requestId, 1);
  assert.equal(complete.summary.toolCallCount, complete.events.length);
  assert.deepEqual(incremental.map((event) => event.id), ["cursor-1", "cursor-2"]);
  assert.equal(await store.listEvents("foreign", context.requestId, 1), undefined);
});

test("redacts PII classes from nested trace payloads", () => {
  const recorder = createInMemoryTraceRecorder("trace_pii", "req_pii");
  recorder.record(base(recorder, "final_response", "pii", { answerPreview: "a@example.com 13812345678 11010519491231002X 6222 0201 2345 6789 012", ok: true }));
  const serialized = JSON.stringify(recorder.getTrace());
  for (const secret of ["a@example.com", "13812345678", "11010519491231002X", "6222 0201 2345 6789 012"]) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /redacted:email/);
});
