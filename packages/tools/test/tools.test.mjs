import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { z } from "zod";
import { createDefaultToolRegistry, getToolRegistrySummary, isReadonlySql, ToolRegistry } from "../dist/index.js";

test("default registry exposes and executes the week 1 mock tools", async () => {
  const registry = createDefaultToolRegistry();
  const summary = getToolRegistrySummary(registry);

  assert.equal(summary.availableTools, 5);
  assert.deepEqual(summary.toolNames, [
    "calculator",
    "market_data_mock",
    "filing_search_mock",
    "financial_metric_mock",
    "sql_query_mock"
  ]);

  const calculator = await registry.execute("calculator", { expression: "12.5 * 8" });
  assert.equal(calculator.ok, true);
  assert.equal(calculator.result.value, 100);

  const market = await registry.execute("market_data_mock", { ticker: "000001.SZ" });
  assert.equal(market.ok, true);
  assert.equal(market.result.lastPrice, 10.85);

  const filing = await registry.execute("filing_search_mock", {
    ticker: "000001.SZ",
    query: "资产质量"
  });
  assert.equal(filing.ok, true);
  assert.match(filing.result.filings[0].snippet, /资产质量/);

  const metrics = await registry.execute("financial_metric_mock", { ticker: "000001.SZ" });
  assert.equal(metrics.ok, true);
  assert.equal(metrics.result.metrics.net_profit.value, 14932000000);
  assert.equal(metrics.result.metrics.roe.value, 3.42);
});

test("safe tools execute without approval", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_safe_tool");
  const result = await registry.execute("calculator", { expression: "2 + 3" }, { trace });

  assert.equal(result.ok, true);
  assert.equal(result.result.value, 5);
  assert.equal(trace.getEvents().some((event) => event.type === "approval"), false);
});

test("readonly sql requires approval and executes after approval decision", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_sql_approval");
  const pending = await registry.execute("sql_query_mock", { query: "SELECT ticker, roe FROM metrics" }, { trace });

  assert.equal(pending.ok, false);
  assert.equal(pending.error.code, "permission_required");
  assert.equal(pending.approvalRequest.permissionLevel, "needs_approval");
  assert.equal(trace.getEvents().some((event) => event.type === "approval" && event.status === "requested"), true);

  const approved = await registry.execute(
    "sql_query_mock",
    { query: "SELECT ticker, roe FROM metrics" },
    {
      trace,
      approvalDecisions: [
        {
          approvalId: pending.approvalRequest.approvalId,
          decision: "approved",
          requestId: pending.approvalRequest.requestId,
          inputDigest: pending.approvalRequest.inputDigest,
          reviewerNote: "test approval"
        }
      ]
    }
  );

  assert.equal(approved.ok, true);
  assert.equal(approved.result.rowCount, 1);
  assert.equal(trace.getEvents().some((event) => event.type === "approval" && event.status === "approved"), true);
});

test("request allowlist and approval binding reject privilege escalation", async () => {
  const registry = createDefaultToolRegistry();
  const denied = await registry.execute("market_data_mock", { ticker: "000001.SZ" }, { allowedTools: ["calculator"] });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.details.reasonCode, "SEC_TOOL_NOT_ALLOWLISTED");

  const trace = createInMemoryTraceRecorder("trace_forged", "req_forged");
  const pending = await registry.execute("sql_query_mock", { query: "SELECT * FROM metrics" }, { trace });
  const forged = await registry.execute("sql_query_mock", { query: "SELECT * FROM metrics" }, { trace, approvalDecisions: [{ approvalId: pending.approvalRequest.approvalId, decision: "approved", requestId: "req_other", inputDigest: pending.approvalRequest.inputDigest }] });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "permission_required");
});

test("readonly SQL rejects multiple statements, comments and dangerous read primitives", () => {
  assert.equal(isReadonlySql("SELECT ';' AS value"), true);
  assert.equal(isReadonlySql("SELECT * FROM filings; DROP TABLE filings"), false);
  assert.equal(isReadonlySql("SELECT * FROM filings /* harmless-looking */"), false);
  assert.equal(isReadonlySql("WITH x AS (DELETE FROM filings RETURNING *) SELECT * FROM x"), false);
  assert.equal(isReadonlySql("SELECT pg_read_file('/etc/passwd')"), false);
});

test("sql write operations are blocked by readonly validator", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_sql_blocked");
  const result = await registry.execute("sql_query_mock", { query: "DROP TABLE filings" }, { trace });

  assert.equal(isReadonlySql("SELECT * FROM filings"), true);
  assert.equal(isReadonlySql("DROP TABLE filings"), false);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(result.approvalRequest.permissionLevel, "blocked");
  assert.equal(trace.getEvents().some((event) => event.type === "approval" && event.status === "rejected"), true);
});

test("zod validation errors are returned and recorded instead of thrown", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_validation_test");
  const result = await registry.execute("financial_metric_mock", {}, { trace });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "validation_error");
  assert.equal(trace.getEvents().length, 1);
  assert.equal(trace.getEvents()[0].ok, false);
  assert.equal(trace.getEvents()[0].error.code, "validation_error");
});

test("tool execution errors are structured and traced", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_execution_test");
  const result = await registry.execute("calculator", { expression: "12.5 *" }, { trace });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "execution_error");
  assert.equal(trace.getEvents().length, 1);
  assert.equal(trace.getEvents()[0].toolName, "calculator");
  assert.equal(trace.getEvents()[0].ok, false);
  assert.equal(trace.getEvents()[0].error.code, "execution_error");
});

test("successful tool calls are written to trace with args, result and latency", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_success_test");
  const result = await registry.execute("market_data_mock", { ticker: "000001.SZ" }, { trace });
  const [event] = trace.getEvents();

  assert.equal(result.ok, true);
  assert.equal(event.type, "tool_call");
  assert.equal(event.traceId, "trace_success_test");
  assert.deepEqual(event.args, { ticker: "000001.SZ" });
  assert.equal(event.result.lastPrice, 10.85);
  assert.equal(typeof event.durationMs, "number");
});

test("trace recorder redacts sensitive fields from tool args", async () => {
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("trace_redaction_test", "req_redaction_test");
  await registry.execute(
    "financial_metric_mock",
    { ticker: "000001.SZ", apiKey: "should-not-be-stored", nested: { token: "secret-token" } },
    { trace }
  );
  const [event] = trace.getEvents();

  assert.equal(event.requestId, "req_redaction_test");
  assert.equal(event.args.apiKey, "[redacted]");
  assert.equal(event.args.nested.token, "[redacted]");
});

test("temporary tool failure retries without real waiting", async () => {
  let calls = 0;
  const delays = [];
  const registry = new ToolRegistry().register({ name: "flaky", description: "test", inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }), execute: () => { calls += 1; if (calls === 1) throw Object.assign(new Error("temporary"), { retryable: true }); return { value: 7 }; } });
  const result = await registry.execute("flaky", {}, { sleep: async (delay) => { delays.push(delay); }, retry: { jitterRatio: 0 } });
  assert.equal(result.ok, true); assert.equal(result.attempts, 2); assert.deepEqual(delays, [100]);
});

test("side effect tool is not retried without idempotency guarantee", async () => {
  let calls = 0;
  const registry = new ToolRegistry().register({ name: "write", description: "test", hasSideEffects: true, inputSchema: z.object({}), outputSchema: z.object({}), execute: () => { calls += 1; throw Object.assign(new Error("temporary"), { retryable: true }); } });
  const result = await registry.execute("write", {}, { sleep: async () => undefined });
  assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(result.attempts, 1);
});

test("slow tool is bounded by timeout", async () => {
  const registry = new ToolRegistry().register({ name: "slow", description: "test", inputSchema: z.object({}), outputSchema: z.object({}), execute: () => new Promise(() => undefined) });
  const result = await registry.execute("slow", {}, { timeoutMs: 1, retry: { maxAttempts: 1 } });
  assert.equal(result.ok, false); assert.equal(result.error.code, "timeout");
});
