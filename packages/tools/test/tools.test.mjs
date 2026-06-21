import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { createDefaultToolRegistry, getToolRegistrySummary } from "../dist/index.js";

test("default registry exposes and executes the week 1 mock tools", async () => {
  const registry = createDefaultToolRegistry();
  const summary = getToolRegistrySummary(registry);

  assert.equal(summary.availableTools, 4);
  assert.deepEqual(summary.toolNames, [
    "calculator",
    "market_data_mock",
    "filing_search_mock",
    "financial_metric_mock"
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
