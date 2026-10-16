import { ToolRegistry } from "./registry.js";
import { calculatorTool } from "./tools/calculator.js";
import { createMarketDataTool } from "./tools/market-data.js";
import { createFilingSearchTool } from "./tools/filing-search.js";
import { createFinancialMetricTool } from "./tools/financial-metric.js";
import { createUnconfiguredDataSource, type FinancialDataSource } from "./data-source.js";
import type { ToolRegistrySummary } from "./types.js";

/**
 * 创建默认工具注册表：注入 FinancialDataSource，注册真实 calculator 与三个真实数据工具适配器
 * （market_data / filing_search / financial_metric）。
 * 数据源默认未配置，工具在调用时返回结构化错误而非抛异常中断 run。
 *
 * @param dataSource 金融数据源端口；缺省使用未配置实现（调用即返回未配置提示）。
 * @returns 已注册 calculator、market_data、filing_search、financial_metric 的 registry。
 */
export function createDefaultToolRegistry(
  dataSource: FinancialDataSource = createUnconfiguredDataSource(),
): ToolRegistry {
  return new ToolRegistry()
    .register(calculatorTool)
    .register(createMarketDataTool(dataSource))
    .register(createFilingSearchTool(dataSource))
    .register(createFinancialMetricTool(dataSource));
}

/**
 * 获取 tools package 摘要，便于前端或验收脚本确认 registry 内容。
 *
 * @param registry 可选 registry，默认使用内置工具集。
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
