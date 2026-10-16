import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  financialMetricsInputSchema,
  financialMetricsOutputSchema,
  marketDataInputSchema,
  marketDataOutputSchema,
  searchFilingsInputSchema,
  searchFilingsOutputSchema
} from "./schemas.js";
import { createMcpFinancialToolRuntime, type McpFinancialToolRuntime } from "./runtime.js";

/**
 * 创建并注册金融研究工具的 MCP server，但不绑定具体 transport。
 *
 * transport 与工具 runtime 分离后，生产入口可使用 stdio，测试可使用 SDK client transport，
 * 后续也能增加 HTTP transport 而不改动工具业务逻辑。
 *
 * @param runtime 可注入的工具 runtime，默认使用本地 RAG 实现。
 * @returns 已注册三个金融研究工具的 MCP server。
 */
export function createFinancialResearchMcpServer(
  runtime: McpFinancialToolRuntime = createMcpFinancialToolRuntime()
): McpServer {
  const server = new McpServer({ name: "aiagent-financial-research", version: "0.1.0" });

  server.registerTool("search_filings", {
    title: "Search Filings",
    description: "Search filing snippets with citations and relevance scores from the local RAG runtime.",
    inputSchema: searchFilingsInputSchema,
    outputSchema: searchFilingsOutputSchema
  }, async (input) => toCallToolResult(await runtime.searchFilings(input)));

  server.registerTool("get_financial_metrics", {
    title: "Get Financial Metrics",
    description: "Get selected financial metric values, periods, units, and sources from the configured data source.",
    inputSchema: financialMetricsInputSchema,
    outputSchema: financialMetricsOutputSchema
  }, async (input) => toCallToolResult(await runtime.getFinancialMetrics(input)));

  server.registerTool("get_market_data", {
    title: "Get Market Data",
    description: "Get selected market summary fields from the configured data source.",
    inputSchema: marketDataInputSchema,
    outputSchema: marketDataOutputSchema
  }, async (input) => toCallToolResult(await runtime.getMarketData(input)));

  return server;
}

/**
 * 将 package 内部 envelope 映射为 MCP content + structuredContent。
 *
 * MCP 的 `isError` 告诉协议 client 调用失败，同时 structuredContent 仍保留稳定错误码，
 * 避免调用方只能解析自然语言异常。
 *
 * @param result 可 JSON 序列化的工具结果。
 * @returns 符合 MCP CallToolResult 的协议结果。
 */
function toCallToolResult(result: { ok: boolean }): CallToolResult {
  const structuredContent = result as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent,
    ...(result.ok ? {} : { isError: true })
  };
}
