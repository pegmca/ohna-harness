import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createDefaultToolRegistry,
  defineAgentTool,
  getToolRegistrySummary,
  ToolRegistry,
  withTimeoutAndRetry
} from "../dist/index.js";

test("default registry exposes calculator and the three real data tools as AgentTool", async () => {
  const registry = createDefaultToolRegistry();
  const summary = getToolRegistrySummary(registry);

  assert.equal(summary.availableTools, 4);
  assert.deepEqual(summary.toolNames, [
    "calculator",
    "market_data",
    "filing_search",
    "financial_metric"
  ]);

  for (const tool of registry.list()) {
    // AgentTool 形状：name/description/label/parameters(zod)/execute/source。
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.label, "string");
    assert.equal(typeof tool.parameters.safeParse, "function");
    assert.equal(typeof tool.execute, "function");
    assert.equal(tool.source, "real");
  }
});

test("calculator executes through the AgentTool contract", async () => {
  const tool = createDefaultToolRegistry().get("calculator");
  const result = await tool.execute("call_1", { expression: "12.5 * 8" });

  assert.deepEqual(result.content, [{ type: "text", text: "12.5 * 8 = 100" }]);
  assert.deepEqual(result.details, { expression: "12.5 * 8", value: 100 });
});

test("data tools return not-configured error when source is unconfigured", async () => {
  const registry = createDefaultToolRegistry();

  const market = await registry.get("market_data").execute("call_2", { ticker: "000001.SZ" });
  assert.equal(market.isError, true);
  assert.match(market.content[0].text, /金融数据源未配置/);

  const filing = await registry.get("filing_search").execute("call_3", { ticker: "000001.SZ", query: "资产质量" });
  assert.equal(filing.isError, true);
  assert.match(filing.content[0].text, /金融数据源未配置/);

  const metrics = await registry.get("financial_metric").execute("call_4", { ticker: "000001.SZ" });
  assert.equal(metrics.isError, true);
  assert.match(metrics.content[0].text, /金融数据源未配置/);
});

test("zod validation failure throws a structured validation_error", async () => {
  const tool = createDefaultToolRegistry().get("financial_metric");
  await assert.rejects(
    () => tool.execute("call_5", {}),
    (error) => error.code === "validation_error" && Array.isArray(error.details.issues)
  );
});

test("execution failure throws a structured execution_error", async () => {
  const tool = createDefaultToolRegistry().get("calculator");
  await assert.rejects(
    () => tool.execute("call_6", { expression: "12.5 *" }),
    (error) => error.code === "execution_error"
  );
});

test("temporary tool failure retries without real waiting", async () => {
  let calls = 0;
  const delays = [];
  const tool = defineAgentTool({
    name: "flaky",
    description: "test",
    parameters: z.object({}),
    execution: { retry: { jitterRatio: 0 }, sleep: async (delay) => { delays.push(delay); } },
    execute: () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary"), { retryable: true });
      return { value: 7 };
    }
  });

  const result = await tool.execute("call_9", {});
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
  assert.deepEqual(result.details, { value: 7 });
});

test("side effect tool is not retried without idempotency guarantee", async () => {
  let calls = 0;
  const tool = defineAgentTool({
    name: "write",
    description: "test",
    parameters: z.object({}),
    execution: { hasSideEffects: true, sleep: async () => undefined },
    execute: () => {
      calls += 1;
      throw Object.assign(new Error("temporary"), { retryable: true });
    }
  });

  await assert.rejects(() => tool.execute("call_10", {}), (error) => error.code === "execution_error");
  assert.equal(calls, 1);
});

test("slow tool is bounded by timeout", async () => {
  const tool = defineAgentTool({
    name: "slow",
    description: "test",
    parameters: z.object({}),
    execution: { timeoutMs: 1, retry: { maxAttempts: 1 } },
    execute: () => new Promise(() => undefined)
  });

  await assert.rejects(() => tool.execute("call_11", {}), (error) => error.code === "timeout");
});

test("deadline budget intersects with the single-attempt timeout", async () => {
  const now = () => 1_000;
  await assert.rejects(
    () => withTimeoutAndRetry(() => 1, { now, deadlineAtMs: 999 }),
    (error) => error.code === "deadline_exceeded"
  );
});

test("abort signal cancels execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => withTimeoutAndRetry(() => 1, { signal: controller.signal }),
    (error) => error.code === "cancelled"
  );
});

test("output schema mismatch throws output_validation_error", async () => {
  const tool = defineAgentTool({
    name: "bad_output",
    description: "test",
    parameters: z.object({}),
    outputSchema: z.object({ value: z.number() }),
    execute: () => ({ wrong: true })
  });

  await assert.rejects(
    () => tool.execute("call_12", {}),
    (error) => error.code === "output_validation_error" && Array.isArray(error.details.issues)
  );
});

test("registry rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  const tool = defineAgentTool({ name: "dup", description: "test", parameters: z.object({}), execute: () => ({}) });
  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/);
});
