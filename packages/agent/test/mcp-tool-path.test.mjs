import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createCombinedToolRegistry } from "@aiagent/mcp";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { runAgent } from "../dist/index.js";

let combined;

before(async () => {
  combined = await createCombinedToolRegistry();
});

after(async () => {
  await combined.close();
});

test("Agent routes filing search to MCP search_filings when preferMcpTools is true", async () => {
  const trace = createInMemoryTraceRecorder("trace_agent_mcp_filing");
  const response = await runAgent(
    { message: "检索一下 000001.SZ 最近年报中关于资产质量的描述。" },
    {
      traceRecorder: trace,
      toolRegistry: combined.registry,
      preferMcpTools: true
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /MCP/);
  assert.match(response.answer, /search_filings/);

  const mcpCallEvent = trace.getEvents().find((event) => event.type === "mcp_tool_call");
  assert.ok(mcpCallEvent);
  assert.equal(mcpCallEvent.toolName, "search_filings");
  assert.equal(mcpCallEvent.ok, true);
});

test("Agent routes financial metric query to MCP get_financial_metrics when preferMcpTools is true", async () => {
  const trace = createInMemoryTraceRecorder("trace_agent_mcp_metric");
  const response = await runAgent(
    { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。" },
    {
      traceRecorder: trace,
      toolRegistry: combined.registry,
      preferMcpTools: true
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /MCP/);
  assert.match(response.answer, /get_financial_metrics/);

  const mcpCallEvent = trace.getEvents().find((event) => event.type === "mcp_tool_call");
  assert.ok(mcpCallEvent);
  assert.equal(mcpCallEvent.toolName, "get_financial_metrics");
  assert.equal(mcpCallEvent.ok, true);
});

test("Agent still uses REST tools when preferMcpTools is false", async () => {
  const trace = createInMemoryTraceRecorder("trace_agent_rest_metric");
  const response = await runAgent(
    { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。" },
    {
      traceRecorder: trace,
      toolRegistry: combined.registry,
      preferMcpTools: false
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /financial_metric_mock/);

  const toolCallEvent = trace.getEvents().find((event) => event.type === "tool_call");
  assert.ok(toolCallEvent);
  assert.equal(toolCallEvent.toolName, "financial_metric_mock");
  assert.equal(toolCallEvent.ok, true);
  assert.equal(trace.getEvents().some((event) => event.type === "mcp_tool_call"), false);
});

test("Agent returns structured tool_not_found when MCP tool is missing and no fallback exists", async () => {
  const trace = createInMemoryTraceRecorder("trace_agent_mcp_missing");
  const response = await runAgent(
    { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。" },
    {
      traceRecorder: trace,
      toolRegistry: combined.registry,
      preferMcpTools: true,
      router: {
        async route() {
          return {
            intent: "tool",
            confidence: 1,
            reason: "force missing mcp tool",
            matchedRules: ["test"],
            tool: { toolName: "missing_mcp_tool", args: { companyId: "000001.SZ" }, reason: "test missing" }
          };
        }
      }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "tool_not_found");
});
