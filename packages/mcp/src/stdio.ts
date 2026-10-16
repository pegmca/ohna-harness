#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFinancialResearchMcpServer } from "./server.js";
import { createMcpFinancialToolRuntime, type McpFinancialToolRuntime } from "./runtime.js";

/**
 * 按环境变量加载可选的离线测试替身数据源。
 *
 * 仅当 AIAGENT_MCP_FAKE_DATA_SOURCE 被显式设置为一个 file:// 模块地址时才会动态导入，
 * 用于行为测试驱动三个真实数据工具返回 canned 数据。生产路径不会设置该变量，
 * 因此默认仍使用未配置数据源（工具返回 isError），不绕过 de-mock 决策。
 *
 * @returns 注入了测试替身的 runtime；未设置环境变量时返回 undefined（交由 server 使用默认）。
 */
async function loadTestRuntime(): Promise<McpFinancialToolRuntime | undefined> {
  const fakeDataSourceUrl = process.env.AIAGENT_MCP_FAKE_DATA_SOURCE;
  if (!fakeDataSourceUrl) {
    return undefined;
  }
  const mod = await import(fakeDataSourceUrl) as {
    createFakeFinancialDataSource?: () => Promise<import("@aiagent/tools").FinancialDataSource>;
  };
  if (typeof mod.createFakeFinancialDataSource !== "function") {
    throw new Error(
      `测试替身模块 ${fakeDataSourceUrl} 必须导出 createFakeFinancialDataSource 工厂函数`
    );
  }
  return createMcpFinancialToolRuntime(await mod.createFakeFinancialDataSource());
}

/**
 * 启动 stdio MCP server；stdout 专用于协议消息，启动错误只写 stderr。
 *
 * @returns server transport 建立完成后的 Promise。
 */
async function main(): Promise<void> {
  const runtime = await loadTestRuntime();
  const server = createFinancialResearchMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown MCP server startup error.";
  process.stderr.write(`[aiagent-mcp] ${message}\n`);
  process.exitCode = 1;
});
