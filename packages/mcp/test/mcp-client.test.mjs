import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import {
  createCombinedToolRegistry,
  createMcpStdioClient,
  createMcpToolRegistry
} from "../dist/index.js";

let client;

before(async () => {
  client = await createMcpStdioClient({ clientName: "aiagent-mcp-client-test" });
});

after(async () => {
  await client.close();
});

test("MCP client discovers the three financial research tools", async () => {
  const tools = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, ["get_financial_metrics", "get_market_data", "search_filings"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.description, "string");
  }
});

test("MCP client calls search_filings and returns structured envelope", async () => {
  const result = await client.callTool("search_filings", {
    companyId: "000001.SZ",
    query: "不良贷款率",
    topK: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.data.source, "mock_rag_runtime");
  assert.ok(result.result.data.snippets.length > 0);
  assert.equal(typeof result.result.data.snippets[0].citation.chunkId, "string");
});

test("MCP client calls get_financial_metrics and returns selected metrics", async () => {
  const result = await client.callTool("get_financial_metrics", {
    companyName: "平安银行",
    metrics: ["net_profit", "roe"]
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.ok, true);
  assert.deepEqual(
    result.result.data.metrics.map(({ metric }) => metric),
    ["net_profit", "roe"]
  );
});

test("MCP tool registry discovers tools and records mcp_tool_discovered trace", async () => {
  const trace = createInMemoryTraceRecorder("trace_mcp_discovery");
  const { registry, toolNames, ok } = await createMcpToolRegistry(client, { trace });

  assert.equal(ok, true);
  assert.deepEqual(toolNames.sort(), ["get_financial_metrics", "get_market_data", "search_filings"]);
  assert.equal(registry.list().length, 3);

  const discoveryEvent = trace.getEvents().find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.ok, true);
  assert.ok(discoveryEvent.toolNames.includes("search_filings"));
});

test("MCP tool registry executes search_filings through ToolRegistry", async () => {
  const { registry } = await createMcpToolRegistry(client);
  const result = await registry.execute("search_filings", {
    companyId: "000001.SZ",
    query: "资产质量",
    topK: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.toolName, "search_filings");
  assert.equal(result.result.ok, true);
});

test("MCP tool registry writes mcp_tool_call trace event on execution", async () => {
  const trace = createInMemoryTraceRecorder("trace_mcp_call");
  const { registry } = await createMcpToolRegistry(client);
  await registry.execute(
    "get_financial_metrics",
    { companyId: "000001.SZ", metrics: ["net_profit"] },
    { trace }
  );

  const callEvent = trace.getEvents().find((event) => event.type === "mcp_tool_call");
  assert.ok(callEvent);
  assert.equal(callEvent.toolName, "get_financial_metrics");
  assert.equal(callEvent.ok, true);
});

test("combined registry includes REST tools when MCP server is unavailable", async () => {
  const trace = createInMemoryTraceRecorder("trace_mcp_unavailable");
  const { registry, mcpAvailable, mcpToolNames, close } = await createCombinedToolRegistry({
    mcpClientOptions: { command: "node", args: ["--eval", "process.exit(1)"] },
    fallbackToRest: true,
    trace
  });

  assert.equal(mcpAvailable, false);
  assert.deepEqual(mcpToolNames, []);
  assert.ok(registry.get("financial_metric_mock"));
  assert.ok(registry.get("filing_search_mock"));
  const discoveryEvent = trace.getEvents().find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.ok, false);
  assert.equal(discoveryEvent.error.code, "mcp_server_unavailable");
  await close();
});

test("combined registry includes both REST and MCP tools when server is available", async () => {
  const trace = createInMemoryTraceRecorder("trace_combined_registry");
  const { registry, mcpAvailable, mcpToolNames, close } = await createCombinedToolRegistry({ trace });

  assert.equal(mcpAvailable, true);
  assert.ok(mcpToolNames.includes("search_filings"));
  assert.ok(registry.get("search_filings"));
  assert.ok(registry.get("financial_metric_mock"));

  const discoveryEvent = trace.getEvents().find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.ok, true);

  await close();
});

test("MCP tool execution failure returns structured error without crashing", async () => {
  const { registry } = await createMcpToolRegistry(client);
  const result = await registry.execute("get_market_data", { ticker: "UNKNOWN", range: "1d", fields: ["summary"] });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "execution_error");
});

test("MCP tool registry returns structured validation errors for schema mismatch", async () => {
  const { registry } = await createMcpToolRegistry(client);
  const result = await registry.execute("search_filings", {
    companyId: "000001.SZ",
    query: "资产质量",
    topK: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "validation_error");
  assert.ok(Array.isArray(result.error.details.issues));
});

test("MCP tool registry returns structured output errors for incompatible server output", async () => {
  const incompatibleClient = {
    serverName: "incompatible-test-server",
    async listTools() {
      return [{ name: "search_filings", description: "test", inputSchema: { type: "object" } }];
    },
    async callTool() {
      return { ok: true, result: { unexpected: true } };
    },
    async close() {}
  };
  const { registry } = await createMcpToolRegistry(incompatibleClient);
  const result = await registry.execute("search_filings", {
    companyId: "000001.SZ",
    query: "资产质量",
    topK: 1
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "output_validation_error");
  assert.ok(Array.isArray(result.error.details.issues));
});
