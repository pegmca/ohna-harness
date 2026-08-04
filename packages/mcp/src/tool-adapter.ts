import { assembleUntrustedContext } from "@aiagent/security";
import { defineAgentTool } from "@aiagent/tools";
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
 * `mcp_tool_discovered` 事件载荷：字段与旧 trace 事件本体保持一致，
 * 区别只是出口从 TraceRecorder 改为 run_events sink（见 06 文档事件映射表）。
 */
export interface McpToolDiscoveredPayload {
  serverName: string;
  toolNames: string[];
  ok: boolean;
  durationMs: number;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * discovery 事件出口（对齐 report 工具的 sink 模式）：
 * 由装配层转写 run_events 落库 + SSE 广播；packages/mcp 本身不感知持久化。
 */
export type McpToolEventSink = (event: {
  type: "mcp_tool_discovered";
  payload: McpToolDiscoveredPayload;
}) => void | Promise<void>;

export interface DiscoverMcpAgentToolsOptions {
  /** 可选事件出口；缺省时 discovery 只返回结构化结果，不产生任何事件。 */
  sink?: McpToolEventSink;
}

export interface DiscoverMcpAgentToolsResult {
  /** 可直接并入 agentLoop config.tools 的 AgentTool 数组（pi 形状，zod schema 保留）。 */
  tools: AgentTool[];
  /** 发现的 MCP tool 名称列表。 */
  toolNames: string[];
  /** MCP server 是否成功连接并发现工具。 */
  ok: boolean;
  /** 当 ok 为 false 时，包含结构化错误信息。 */
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * 把已发现的 MCP tool 摘要转成工具名列表。
 *
 * @param summaries MCP server 返回的工具摘要。
 * @returns 工具名数组。
 */
export function toMcpToolNames(summaries: McpToolSummary[]): string[] {
  return summaries.map((tool) => tool.name);
}

/**
 * 用已知 zod schema 包装 `search_filings` 为 pi 形状 AgentTool。
 *
 * @param client 已连接的 MCP client。
 * @returns 可直接放入 agentLoop config.tools 的 AgentTool。
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
 * @returns 可直接放入 agentLoop config.tools 的 AgentTool。
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
 * @returns 可直接放入 agentLoop config.tools 的 AgentTool。
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
 * 通用 MCP tool 包装工厂：把 MCP client 调用映射为 pi 形状的 AgentTool。
 *
 * 设计依据 docs/worktree/06-capability-integration.md 第 3 节：
 * - 保留 zod input/output schema 校验（schemas.ts 原样复用）；schema → JSON Schema
 *   的序列化发生在 agent 包 convert.ts 的 toLlmTools 转换点，本层始终持 zod；
 * - execute 抛错由 loop 统一转成 isError ToolResultMessage 回喂模型，不再经
 *   ToolRegistry 的 ToolExecutionFailure；
 * - 超时/重试由 defineAgentTool 内嵌的 withTimeoutAndRetry 提供，AbortSignal 透传 loop；
 * - 工具输出是不可信内容，回喂模型的文本经 packages/security 的
 *   assembleUntrustedContext 二次封装（与 RAG grounding 同一 <untrusted_context> 约定）；
 *   details 保留原始结构化输出供 trace/UI 使用。
 *
 * @param client 已连接的 MCP client。
 * @param name MCP tool 名称。
 * @param description 工具描述。
 * @param inputSchema zod 输入 schema。
 * @param outputSchema zod 输出 schema。
 * @returns 符合 pi AgentTool 接口的包装器。
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
    formatResult: (output) => wrapMcpToolOutput(name, output),
    async execute(input) {
      const result = await client.callTool(name, input as Record<string, unknown>);

      if (!result.ok) {
        throw new McpToolCallError(result.error.code, result.error.message, result.error.details);
      }

      return result.result as TOutput;
    }
  });
}

/**
 * discovery + 适配：列出 MCP server 工具并包装为 AgentTool 数组，
 * 产出可直接并入 agentLoop config.tools；失败返回结构化错误而非抛异常。
 *
 * 已知工具按 schemas.ts 的 zod schema 包装；未知工具跳过（不能用宽松 schema
 * 破坏模型选择，也无法保证 zod → JSON Schema 转换的表达能力）。
 * 发现结果（含失败）经 sink 写 `mcp_tool_discovered` 事件，事件名与 payload 不变。
 *
 * @param client 已连接的 MCP client。
 * @param options 可选事件 sink。
 * @returns AgentTool 数组与发现结果。
 */
export async function discoverMcpAgentTools(
  client: McpClient,
  options: DiscoverMcpAgentToolsOptions = {}
): Promise<DiscoverMcpAgentToolsResult> {
  const startedAt = performance.now();

  try {
    const summaries = await client.listTools();
    const toolNames = toMcpToolNames(summaries);
    const tools: AgentTool[] = [];

    for (const summary of summaries) {
      const tool = wrapDiscoveredMcpTool(client, summary);
      if (tool) {
        tools.push(tool);
      }
    }

    await emitDiscoveryEvent(options.sink, {
      serverName: client.serverName,
      toolNames,
      ok: true,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100
    });

    return { tools, toolNames, ok: true };
  } catch (error) {
    const failure = {
      code: "mcp_discovery_failed",
      message: error instanceof Error ? error.message : "MCP tool discovery failed.",
      details: { serverName: client.serverName }
    };

    await emitDiscoveryEvent(options.sink, {
      serverName: client.serverName,
      toolNames: [],
      ok: false,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error: failure
    });

    return { tools: [], toolNames: [], ok: false, error: failure };
  }
}

/**
 * 根据 MCP 发现结果创建已知工具的 wrapper；未知工具跳过，避免用宽松 schema 破坏模型选择。
 *
 * @param client 已连接的 MCP client。
 * @param summary MCP tool 摘要。
 * @returns AgentTool 包装器；未知工具返回 undefined。
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
 * 把 MCP 工具输出封装为 <untrusted_context> 文本后回喂模型：
 * MCP server 是外部进程，其输出与检索片段同属不可信内容，
 * 复用 packages/security 的注入评估与封装边界（block 时只留占位符）。
 *
 * @param toolName 工具名（封装块 id 的一部分）。
 * @param output 结构化工具输出。
 * @returns 回喂模型的封装文本。
 */
function wrapMcpToolOutput(toolName: string, output: unknown): string {
  const wrapped = assembleUntrustedContext([{
    id: `mcp_${toolName}`,
    source: "tool_output",
    content: JSON.stringify(output, null, 2)
  }]);
  return wrapped.content;
}

/**
 * 经 sink 发出 mcp_tool_discovered 事件；sink 是旁路观测出口，
 * 落库瞬时失败不得影响 discovery 主流程。
 *
 * @param sink 可选事件出口。
 * @param payload 发现结果载荷。
 */
async function emitDiscoveryEvent(sink: McpToolEventSink | undefined, payload: McpToolDiscoveredPayload): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink({ type: "mcp_tool_discovered", payload });
  } catch {
    // 事件出口是旁路能力，写失败不应影响工具发现结果。
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
