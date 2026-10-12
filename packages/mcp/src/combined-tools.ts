import { createDefaultToolRegistry } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { createMcpStdioClient, type CreateMcpStdioClientOptions, type McpClient } from "./client.js";
import { discoverMcpAgentTools, type McpToolEventSink } from "./tool-adapter.js";

export interface CreateCombinedAgentToolsOptions {
  /** 可选 stdio client 启动参数；不传时使用本 package 内置 server。 */
  mcpClientOptions?: CreateMcpStdioClientOptions;
  /** 可选事件出口：mcp_tool_discovered 由装配层转写 run_events。 */
  sink?: McpToolEventSink;
  /** 当 MCP server 不可用时，true 表示仍返回默认内置 tools。 */
  fallbackToRest?: boolean;
  /**
   * 额外的外部/社区 MCP server（配置即可接入，演示多 server 合并）。
   * 每个项按 CreateMcpStdioClientOptions 启动一个独立 stdio client 并发现工具，
   * 发现的工具并入 tools。单个 server 失败不影响整体——失败项只进 extraServers 列表。
   */
  extraServers?: CreateMcpStdioClientOptions[];
}

/**
 * 单个 extra server 的发现结果（成功或结构化失败），全部进 extraServers 列表，
 * 便于调用方观测哪些外部 server 真正接入成功。
 */
export interface ExtraServerDiscovery {
  /** server 可读标识（取 clientName，缺省回退到默认 client 名）。 */
  serverName: string;
  /** 是否成功连接并发现工具。 */
  ok: boolean;
  /** 发现的工具名称；失败时为空数组。 */
  toolNames: string[];
  /** 失败时包含结构化错误；成功时为 undefined。 */
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface CreateCombinedAgentToolsResult {
  /** 合并后的工具数组，可直接并入 agentLoop config.tools。 */
  tools: AgentTool[];
  /** 是否成功发现内置 MCP tools。 */
  mcpAvailable: boolean;
  /** 发现的（内置）MCP tool 名称；失败时为空数组。 */
  mcpToolNames: string[];
  /** MCP discovery 失败时的结构化错误；成功时为 undefined。 */
  mcpError?: { code: string; message: string; details?: Record<string, unknown> };
  /** 各 extra server 的发现结果（成功或失败），用于观测外部 server 接入状态。 */
  extraServers: ExtraServerDiscovery[];
  /**
   * 关闭底层全部 MCP client 和 transport；调用方应在工具集生命周期结束时调用。
   */
  close(): Promise<void>;
}

/**
 * 装配 agentLoop 用的合并工具集：默认内置 tools + MCP discovery 产出的 AgentTool。
 *
 * 设计依据 docs/worktree/06-capability-integration.md 第 3 节：工具来源合并在装配期完成
 * （替代原 ToolRegistry 合并与 allowedTools 运行时白名单），模型按 description 自主选择。
 * MCP server 不可用时按 fallbackToRest 决定是否保留内置 tools，Agent 不会因此崩溃。
 * 返回值持有已打开的 MCP client，调用方需在生命周期结束时调用 close()。
 *
 * @param options 可选 MCP client 参数、事件 sink 与 fallback 策略。
 * @returns 合并工具数组与 MCP 可用性信息，以及用于释放资源的 close()。
 */
export async function createCombinedAgentTools(
  options: CreateCombinedAgentToolsOptions = {}
): Promise<CreateCombinedAgentToolsResult> {
  const fallbackToRest = options.fallbackToRest ?? true;
  const restTools = createDefaultToolRegistry().list();

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

    await emitUnavailableDiscovery(
      options.sink,
      options.mcpClientOptions?.clientName ?? "aiagent-financial-research",
      discoveryStartedAt,
      mcpError
    );

    return {
      tools: fallbackToRest ? restTools : [],
      mcpAvailable: false,
      mcpToolNames: [],
      mcpError,
      extraServers: [],
      close: async () => { /* MCP client 未创建，无需关闭。 */ }
    };
  }

  const discovered = await discoverMcpAgentTools(client, { sink: options.sink });

  // 合并基线：内置 rest 工具 + 内置 MCP 工具（按 fallback 策略）。
  const tools = fallbackToRest || discovered.ok ? [...restTools, ...discovered.tools] : [...discovered.tools];

  // 额外外部/社区 server：逐个独立连接与发现，失败隔离。
  const extraServers: ExtraServerDiscovery[] = [];
  const extraClients: McpClient[] = [];

  for (const extraOptions of options.extraServers ?? []) {
    const serverName = extraOptions.clientName ?? "aiagent-mcp-client";
    try {
      const extraClient = await createMcpStdioClient(extraOptions);
      extraClients.push(extraClient);
      // 外部 server 工具本就未知，必须 includeUnknown 才能全量并入。
      const extraDiscovered = await discoverMcpAgentTools(extraClient, {
        sink: options.sink,
        includeUnknown: true
      });
      extraServers.push({ serverName, ok: extraDiscovered.ok, toolNames: extraDiscovered.toolNames });
      tools.push(...extraDiscovered.tools);
    } catch (error) {
      // 单个外部 server 失败绝不拖垮整体：只记录结构化失败，工具被省略。
      extraServers.push({
        serverName,
        ok: false,
        toolNames: [],
        error: {
          code: "mcp_extra_server_unavailable",
          message: error instanceof Error ? error.message : "Extra MCP server could not be started.",
          details: { clientName: serverName }
        }
      });
    }
  }

  return {
    tools,
    mcpAvailable: discovered.ok,
    mcpToolNames: discovered.toolNames,
    mcpError: discovered.error,
    extraServers,
    close: async () => {
      await client.close().catch(() => {
        // 关闭失败不影响工具集结果。
      });
      for (const extraClient of extraClients) {
        await extraClient.close().catch(() => {
          // 关闭失败不影响工具集结果。
        });
      }
    }
  };
}

/**
 * MCP transport 尚未建立时发出 discovery 失败事件，使 fallback 也能在 run_events 中被观察。
 *
 * @param sink 可选事件出口。
 * @param serverName 目标 MCP server 的可读标识。
 * @param startedAt discovery 失败处理的计时起点。
 * @param error 结构化连接错误。
 */
async function emitUnavailableDiscovery(
  sink: McpToolEventSink | undefined,
  serverName: string,
  startedAt: number,
  error: { code: string; message: string; details?: Record<string, unknown> }
): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink({
      type: "mcp_tool_discovered",
      payload: {
        serverName,
        toolNames: [],
        ok: false,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error
      }
    });
  } catch {
    // 事件出口是旁路能力，写失败不能阻断 fallback。
  }
}
