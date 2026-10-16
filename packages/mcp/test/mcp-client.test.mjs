import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createCombinedAgentTools,
  createMcpStdioClient,
  discoverMcpAgentTools
} from "../dist/index.js";

// 注入离线测试替身数据源：让三个真实数据工具返回 canned 数据而非「未配置」isError。
// MCP SDK 默认只继承少量安全环境变量，自定义变量必须显式经 client 的 env 透传给 stdio 子进程。
const FAKE_DATA_SOURCE_URL =
  new URL("./fixtures/fake-data-source.mjs", import.meta.url).href;
process.env.AIAGENT_MCP_FAKE_DATA_SOURCE = FAKE_DATA_SOURCE_URL;

let client;

/** 收集 sink 事件的内存数组，模拟装配层把 mcp_tool_discovered 转写 run_events。 */
function createEventCollector() {
  const events = [];
  return { events, sink: (event) => { events.push(event); } };
}

before(async () => {
  client = await createMcpStdioClient({
    clientName: "aiagent-mcp-client-test",
    env: { AIAGENT_MCP_FAKE_DATA_SOURCE: FAKE_DATA_SOURCE_URL }
  });
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

test("discoverMcpAgentTools returns AgentTool array and emits mcp_tool_discovered via sink", async () => {
  const { events, sink } = createEventCollector();
  const { tools, toolNames, ok } = await discoverMcpAgentTools(client, { sink });

  assert.equal(ok, true);
  assert.deepEqual(toolNames.sort(), ["get_financial_metrics", "get_market_data", "search_filings"]);
  assert.equal(tools.length, 3);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.description, "string");
    // pi AgentTool 形状：parameters 持 zod schema（JSON Schema 序列化在 agent convert.ts 转换点）。
    assert.equal(typeof tool.parameters.parse, "function");
  }

  const discoveryEvent = events.find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.payload.ok, true);
  assert.ok(discoveryEvent.payload.toolNames.includes("search_filings"));
  assert.equal(discoveryEvent.payload.serverName, client.serverName);
});

test("discovered AgentTool executes search_filings through the pi AgentTool contract", async () => {
  const { tools } = await discoverMcpAgentTools(client);
  const tool = tools.find((item) => item.name === "search_filings");
  assert.ok(tool);
  const result = await tool.execute("call_1", {
    companyId: "000001.SZ",
    query: "资产质量",
    topK: 1
  });

  // details 保留原始结构化输出；回喂模型的 content 经 <untrusted_context> 安全封装。
  assert.equal(result.details.ok, true);
  assert.ok(Array.isArray(result.details.data.snippets));
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.ok(text.includes("<untrusted_context"), "MCP 工具输出应经 security 二次封装");
  assert.ok(text.includes('source="tool_output"'));
});

test("combined tools include built-in tools when MCP server is unavailable", async () => {
  const { events, sink } = createEventCollector();
  const { tools, mcpAvailable, mcpToolNames, close } = await createCombinedAgentTools({
    mcpClientOptions: { command: "node", args: ["--eval", "process.exit(1)"] },
    fallbackToRest: true,
    sink
  });

  assert.equal(mcpAvailable, false);
  assert.deepEqual(mcpToolNames, []);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("financial_metric"));
  assert.ok(names.includes("filing_search"));
  const discoveryEvent = events.find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.payload.ok, false);
  assert.equal(discoveryEvent.payload.error.code, "mcp_server_unavailable");
  await close();
});

test("combined tools include both built-in and MCP tools when server is available", async () => {
  const { events, sink } = createEventCollector();
  const { tools, mcpAvailable, mcpToolNames, close } = await createCombinedAgentTools({ sink });

  assert.equal(mcpAvailable, true);
  assert.ok(mcpToolNames.includes("search_filings"));
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("search_filings"));
  assert.ok(names.includes("financial_metric"));

  const discoveryEvent = events.find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.payload.ok, true);

  await close();
});

test("MCP tool execution failure throws structured error without crashing", async () => {
  const { tools } = await discoverMcpAgentTools(client);
  const tool = tools.find((item) => item.name === "get_market_data");
  await assert.rejects(
    () => tool.execute("call_2", { ticker: "UNKNOWN", range: "1d", fields: ["summary"] }),
    (error) => error.code === "execution_error"
  );
});

test("discovered AgentTool throws structured validation errors for schema mismatch", async () => {
  const { tools } = await discoverMcpAgentTools(client);
  const tool = tools.find((item) => item.name === "search_filings");
  await assert.rejects(
    () => tool.execute("call_3", { companyId: "000001.SZ", query: "资产质量", topK: 0 }),
    (error) => error.code === "validation_error" && Array.isArray(error.details.issues)
  );
});

test("discoverMcpAgentTools returns structured output errors for incompatible server output", async () => {
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
  const { tools } = await discoverMcpAgentTools(incompatibleClient);
  const tool = tools.find((item) => item.name === "search_filings");
  await assert.rejects(
    () => tool.execute("call_4", { companyId: "000001.SZ", query: "资产质量", topK: 1 }),
    (error) => error.code === "output_validation_error" && Array.isArray(error.details.issues)
  );
});

test("discoverMcpAgentTools returns structured error when listTools fails", async () => {
  const failingClient = {
    serverName: "failing-test-server",
    async listTools() {
      throw new Error("connection reset");
    },
    async callTool() {
      return { ok: false, error: { code: "unreachable", message: "unreachable" } };
    },
    async close() {}
  };
  const { events, sink } = createEventCollector();
  const { tools, ok, error } = await discoverMcpAgentTools(failingClient, { sink });

  assert.equal(ok, false);
  assert.deepEqual(tools, []);
  assert.equal(error.code, "mcp_discovery_failed");
  const discoveryEvent = events.find((event) => event.type === "mcp_tool_discovered");
  assert.ok(discoveryEvent);
  assert.equal(discoveryEvent.payload.ok, false);
  assert.equal(discoveryEvent.payload.error.code, "mcp_discovery_failed");
});
