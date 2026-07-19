import { createDefaultToolRegistry } from "@aiagent/tools";
import { ToolRegistry } from "@aiagent/tools";
import type { TraceRecorder } from "@aiagent/trace";
import { createMcpStdioClient, type CreateMcpStdioClientOptions } from "./client.js";
import { createMcpToolRegistry } from "./tool-adapter.js";

export interface CreateCombinedToolRegistryOptions {
  /** 可选 stdio client 启动参数；不传时使用本 package 内置 server。 */
  mcpClientOptions?: CreateMcpStdioClientOptions;
  /** 可选 trace recorder，用于记录 MCP discovery 事件。 */
  trace?: TraceRecorder;
  /** 当 MCP server 不可用时，true 表示仍把默认 REST/mock tools 注册进去。 */
  fallbackToRest?: boolean;
}

export interface CreateCombinedToolRegistryResult {
  /** 合并后的工具注册表；fallbackToRest 为 true 时至少包含 REST tools。 */
  registry: ToolRegistry;
  /** 是否成功发现 MCP tools 并加入 registry。 */
  mcpAvailable: boolean;
  /** 发现的 MCP tool 名称；失败时为空数组。 */
  mcpToolNames: string[];
  /** MCP discovery 失败时的结构化错误；成功时为 undefined。 */
  mcpError?: { code: string; message: string; details?: Record<string, unknown> };
  /**
   * 关闭底层 MCP client 和 transport；调用方应在 registry 生命周期结束时调用。
   */
  close(): Promise<void>;
}

/**
 * 创建同时包含 REST/registry tools 和 MCP tools 的注册表。
 *
 * 该函数先注册默认 REST/mock tools，再尝试连接 MCP server 并发现 tools；
 * MCP 发现成功时追加 MCP tools，失败时按 fallbackToRest 决定是否保留 REST tools。
 * 返回的 registry 持有已打开的 MCP client，调用方需在生命周期结束时调用 close()。
 * 这样 Agent 在 MCP server 不可用时仍能走 REST tool path，不会崩溃。
 *
 * @param options 可选 MCP client 参数、trace recorder 与 fallback 策略。
 * @returns 合并 registry 与 MCP 可用性信息，以及用于释放资源的 close()。
 */
export async function createCombinedToolRegistry(
  options: CreateCombinedToolRegistryOptions = {}
): Promise<CreateCombinedToolRegistryResult> {
  const fallbackToRest = options.fallbackToRest ?? true;
  const restRegistry = createDefaultToolRegistry();
  const registry = new ToolRegistry();

  for (const tool of restRegistry.list()) {
    registry.register(tool);
  }

  let client;
  const discoveryStartedAt = performance.now();

  try {
    client = await createMcpStdioClient(options.mcpClientOptions);
  } catch (error) {
    const mcpError = {
      code: "mcp_server_unavailable",
      message: error instanceof Error ? error.message : "MCP server could not be started.",
      details: { fallbackToRest }
    };

    recordUnavailableDiscovery(
      options.trace,
      options.mcpClientOptions?.clientName ?? "aiagent-financial-research",
      discoveryStartedAt,
      mcpError
    );

    return {
      registry: fallbackToRest ? registry : new ToolRegistry(),
      mcpAvailable: false,
      mcpToolNames: [],
      mcpError,
      close: async () => { /* MCP client 未创建，无需关闭。 */ }
    };
  }

  const mcpResult = await createMcpToolRegistry(client, { trace: options.trace });

  if (mcpResult.ok) {
    for (const tool of mcpResult.registry.list()) {
      registry.register(tool);
    }
  }

  return {
    registry: fallbackToRest || mcpResult.ok ? registry : new ToolRegistry(),
    mcpAvailable: mcpResult.ok,
    mcpToolNames: mcpResult.toolNames,
    mcpError: mcpResult.error,
    close: async () => {
      await client.close().catch(() => {
        // 关闭失败不影响 registry 结果。
      });
    }
  };
}

/**
 * MCP transport 尚未建立时记录 discovery 失败，使 fallback 也能在 trace 中被观察。
 *
 * @param trace 可选 trace recorder。
 * @param serverName 目标 MCP server 的可读标识。
 * @param startedAt discovery 失败处理的计时起点。
 * @param error 结构化连接错误。
 * @returns 无返回值；trace 失败不会影响 REST fallback。
 */
function recordUnavailableDiscovery(
  trace: TraceRecorder | undefined,
  serverName: string,
  startedAt: number,
  error: { code: string; message: string; details?: Record<string, unknown> }
): void {
  if (!trace) {
    return;
  }

  try {
    trace.record({
      type: "mcp_tool_discovered",
      id: `${trace.traceId}_mcp_unavailable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: trace.traceId,
      requestId: trace.requestId,
      serverName,
      toolNames: [],
      ok: false,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路能力，记录失败不能阻断 REST fallback。
  }
}
