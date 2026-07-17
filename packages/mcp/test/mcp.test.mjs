import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/stdio.js", import.meta.url).pathname],
  stderr: "pipe"
});
const client = new Client({ name: "aiagent-mcp-smoke-test", version: "0.1.0" });

before(async () => {
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

test("stdio server exposes the three financial research tools", async () => {
  const response = await client.listTools();
  assert.deepEqual(
    response.tools.map((tool) => tool.name).sort(),
    ["get_financial_metrics", "get_market_data", "search_filings"]
  );
  for (const tool of response.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema?.type, "object");
  }
});

test("search_filings returns snippets, citations, and scores over stdio", async () => {
  const response = await client.callTool({
    name: "search_filings",
    arguments: {
      companyId: "000001.SZ",
      query: "资产质量 不良贷款率",
      topK: 2
    }
  });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.data.source, "mock_rag_runtime");
  assert.ok(response.structuredContent.data.snippets.length > 0);
  assert.equal(typeof response.structuredContent.data.snippets[0].score, "number");
  assert.equal(typeof response.structuredContent.data.snippets[0].citation.chunkId, "string");
  assert.match(response.structuredContent.data.snippets[0].citation.quote, /不良贷款率|资产质量/);
});

test("get_financial_metrics returns only selected metric fields", async () => {
  const response = await client.callTool({
    name: "get_financial_metrics",
    arguments: {
      companyName: "平安银行",
      metrics: ["net_profit", "roe"],
      timeRange: { start: "2026-01-01", end: "2026-03-31" }
    }
  });
  assert.equal(response.structuredContent.ok, true);
  assert.deepEqual(
    response.structuredContent.data.metrics.map(({ metric }) => metric),
    ["net_profit", "roe"]
  );
  for (const metric of response.structuredContent.data.metrics) {
    assert.equal(typeof metric.value, "number");
    assert.equal(typeof metric.period, "string");
    assert.equal(typeof metric.unit, "string");
    assert.equal(metric.source, "mock");
  }
});

test("get_market_data supports requested fields", async () => {
  const response = await client.callTool({
    name: "get_market_data",
    arguments: {
      ticker: "000001.SZ",
      range: "1d",
      fields: ["prices", "returns", "volume", "summary"]
    }
  });
  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.data.prices.length, 1);
  assert.equal(typeof response.structuredContent.data.returns, "number");
  assert.equal(typeof response.structuredContent.data.volume, "number");
  assert.equal(typeof response.structuredContent.data.summary.lastPrice, "number");
});

test("tool runtime exposes structured errors instead of raw exceptions", async () => {
  const response = await client.callTool({
    name: "get_market_data",
    arguments: { ticker: "UNKNOWN", range: "1d", fields: ["summary"] }
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.ok, false);
  assert.equal(response.structuredContent.error.code, "execution_error");
  assert.equal(typeof response.structuredContent.error.message, "string");
});
