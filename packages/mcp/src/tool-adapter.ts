import type { TraceRecorder } from "@aiagent/trace";
import { defineAgentTool, ToolRegistry } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import type { McpClient, McpToolSummary } from "./client.js";
import {
  financialMetricsInputSchema,
  financialMetricsOutputSchema,
  marketDataInputSchema,
  marketDataOutputSchema,
  searchFilingsInputSchema,
  searchFilingsOutputSchema,
  type FinancialMetricsInput,
  type FinancialMetricsOutput,
  type MarketDataInput,
  type MarketDataOutput,
  type SearchFilingsInput,
  type SearchFilingsOutput
} from "./schemas.js";

/**
 * 把已发现的 MCP tool 摘要转成 Agent 可选择的工具名列表。
 *
 * @param summaries MCP server 返回的工具摘要。
 * @returns 工具名数组。
 */
export function toMcpToolNames(summaries: McpToolSummary[]): string[] {
  return summaries.map((tool) => tool.name);
}

/**
 * 用已知 zod schema 包装 `search_filings` 为 AgentTool（MCP 完整适配属阶段 5，本阶段保持可构建）。
 *
 * @param client 已连接的 MCP client。
 * @returns 符合 AgentTool 接口的 search_filings 包装器。
 */
export function createMcpSearchFilingsTool(client: McpClient): AgentTool<z.ZodType<SearchFilingsInput>, SearchFilingsOutput> {
  return createMcpTool(
    client,
    "search_filings",
    "Search filing snippets with citations and relevance scores from the MCP RAG runtime.",
    searchFilingsInputSchema,
    searchFilingsOutputSchema
  );
}

/**
 * 用已知 zod schema 包装 `get_financial_metrics`。
 *
 * @param client 已连接的 MCP client。
 * @returns 符合 Tool 接口的 get_financial_metrics 包装器。
 */
export function createMcpFinancialMetricsTool(client: McpClient): AgentTool<z.ZodType<FinancialMetricsInput>, FinancialMetricsOutput> {
  return createMcpTool(
    client,
    "get_financial_metrics",
    "Get selected financial metric values, periods, units, and sources through MCP.",
    financialMetricsInputSchema,
    financialMetricsOutputSchema
  );
}

/**
 * 用已知 zod schema 包装 `get_market_data`。
 *
 * @param client 已连接的 MCP client。
 * @returns 符合 Tool 接口的 get_market_data 包装器。
 */
export function createMcpMarketDataTool(client: McpClient): AgentTool<z.ZodType<MarketDataInput>, MarketDataOutput> {
  return createMcpTool(
    client,
    "get_market_data",
    "Get selected market summary fields through MCP.",
    marketDataInputSchema,
    marketDataOutputSchema
  );
}

/**
 * 通用 MCP tool 包装工厂：把 MCP client 调用映射为 AgentTool 接口。
 *
 * MCP server 负责输入校验，wrapper 再用 zod outputSchema 校验返回值，捕获 schema 不匹配；
 * 超时/重试包装由 defineAgentTool 内嵌的 withTimeoutAndRetry 提供。
 *
 * @param client 已连接的 MCP client。
 * @param name MCP tool 名称。
 * @param description 工具描述。
 * @param inputSchema zod 输入 schema。
 * @param outputSchema zod 输出 schema。
 * @returns 符合 AgentTool 接口的包装器。
 */
export function createMcpTool<TInput, TOutput>(
  client: McpClient,
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): AgentTool<z.ZodType<TInput>, TOutput> {
  return defineAgentTool({
    name,
    description,
    parameters: inputSchema,
    outputSchema,
    async execute(input) {
      const result = await client.callTool(name, input as Record<string, unknown>);

      if (!result.ok) {
        throw new McpToolCallError(result.error.code, result.error.message, result.error.details);
      }

      return result.result as TOutput;
    }
  });
}

export interface CreateMcpToolRegistryOptions {
  /** 可选 trace recorder，用于在发现阶段写入 mcp_tool_discovered 事件。 */
  trace?: TraceRecorder;
}

export interface McpToolRegistryResult {
  /** 已注册 MCP tools 的 registry。 */
  registry: ToolRegistry;
  /** 发现的 MCP tool 名称列表。 */
  toolNames: string[];
  /** MCP server 是否成功连接并发现工具。 */
  ok: boolean;
  /** 当 ok 为 false 时，包含结构化错误信息。 */
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * 通过 MCP client 发现工具并注册到 ToolRegistry，失败时返回结构化错误而非抛异常。
 *
 * 本函数只负责 discovery 和注册；调用方决定是把 MCP registry 单独给 Agent，
 * 还是与 REST registry 合并。发现成功时会写入 `mcp_tool_discovered` trace event。
 *
 * @param client 已连接的 MCP client。
 * @param options 可选 trace recorder。
 * @returns registry 与发现结果。
 */
export async function createMcpToolRegistry(
  client: McpClient,
  options: CreateMcpToolRegistryOptions = {}
): Promise<McpToolRegistryResult> {
  const startedAt = performance.now();

  try {
    const summaries = await client.listTools();
    const toolNames = toMcpToolNames(summaries);
    const registry = new ToolRegistry();

    for (const summary of summaries) {
      const tool = wrapDiscoveredMcpTool(client, summary);
      if (tool) {
        registry.register(tool);
      }
    }

    recordDiscoveryTrace(options.trace, {
      serverName: client.serverName,
      toolNames,
      ok: true,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100
    });

    return { registry, toolNames, ok: true };
  } catch (error) {
    const failure = {
      code: "mcp_discovery_failed",
      message: error instanceof Error ? error.message : "MCP tool discovery failed.",
      details: { serverName: client.serverName }
    };

    recordDiscoveryTrace(options.trace, {
      serverName: client.serverName,
      toolNames: [],
      ok: false,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: failure
    });

    return { registry: new ToolRegistry(), toolNames: [], ok: false, error: failure };
  }
}

/**
 * 根据 MCP 发现结果创建已知工具的 wrapper；未知工具跳过，避免用宽松 schema 破坏 Agent 选择。
 *
 * @param client 已连接的 MCP client。
 * @param summary MCP tool 摘要。
 * @returns Tool 包装器；未知工具返回 undefined。
 */
function wrapDiscoveredMcpTool(client: McpClient, summary: McpToolSummary): AgentTool | undefined {
  switch (summary.name) {
    case "search_filings":
      return createMcpSearchFilingsTool(client);
    case "get_financial_metrics":
      return createMcpFinancialMetricsTool(client);
    case "get_market_data":
      return createMcpMarketDataTool(client);
    default:
      return undefined;
  }
}

/**
 * 写入 mcp_tool_discovered trace event；trace 失败不影响 registry 创建。
 *
 * @param trace 可选 trace recorder。
 * @param payload 发现结果。
 */
function recordDiscoveryTrace(
  trace: TraceRecorder | undefined,
  payload: {
    serverName: string;
    toolNames: string[];
    ok: boolean;
    durationMs: number;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  }
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "mcp_tool_discovered",
      id: `${trace.traceId}_mcp_discovered_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      serverName: payload.serverName,
      toolNames: payload.toolNames,
      ok: payload.ok,
      durationMs: payload.durationMs,
      ...(payload.error ? { error: payload.error } : {}),
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，发现失败不应影响主流程。
  }
}

/**
 * 用于把 MCP 调用失败转换为 AgentTool.execute 可抛出的异常，
 * agent loop 会捕获并转成 isError 的 ToolResultMessage 回喂模型。
 */
class McpToolCallError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpToolCallError";
    this.code = code;
    this.details = details;
  }
}
