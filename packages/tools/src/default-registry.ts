import { ToolRegistry } from "./registry.js";
import { calculatorTool } from "./tools/calculator.js";
import { filingSearchMockTool } from "./tools/filing-search-mock.js";
import { financialMetricMockTool } from "./tools/financial-metric-mock.js";
import { marketDataMockTool } from "./tools/market-data-mock.js";
import { sqlQueryMockTool } from "./tools/sql-query-mock.js";
import type { ToolRegistrySummary } from "./types.js";

/**
 * 创建默认工具注册表，包含安全 mock tools 和需要审批的 SQL 查询 demo tool。
 *
 * @returns 已注册 calculator、market_data_mock、filing_search_mock、financial_metric_mock、sql_query_mock 的 registry。
 */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(calculatorTool)
    .register(marketDataMockTool)
    .register(filingSearchMockTool)
    .register(financialMetricMockTool)
    .register(sqlQueryMockTool);
}

/**
 * 获取 tools package 摘要，便于前端或验收脚本确认 registry 内容。
 *
 * @param registry 可选 registry，默认使用内置 mock tools。
 * @returns package 名称、工具数量和工具名列表。
 */
export function getToolRegistrySummary(registry = createDefaultToolRegistry()): ToolRegistrySummary {
  const toolNames = registry.list().map((tool) => tool.name);

  return {
    packageName: "@aiagent/tools",
    availableTools: toolNames.length,
    toolNames
  };
}
