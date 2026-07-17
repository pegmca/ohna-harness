#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFinancialResearchMcpServer } from "./server.js";

/**
 * 启动 stdio MCP server；stdout 专用于协议消息，启动错误只写 stderr。
 *
 * @returns server transport 建立完成后的 Promise。
 */
async function main(): Promise<void> {
  const server = createFinancialResearchMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown MCP server startup error.";
  process.stderr.write(`[aiagent-mcp] ${message}\n`);
  process.exitCode = 1;
});
