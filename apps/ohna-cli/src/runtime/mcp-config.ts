/**
 * `--mcp <config.json>` 接线：加载外部 MCP server 配置、逐个连接并发现工具。
 *
 * 信任边界说明（C-M3-4）：外部工具的输出**已经**由 `packages/mcp` 的 tool-adapter
 * 在 formatResult 阶段经 `assembleUntrustedContext` 封装为 `<untrusted_context>` 块
 * （见 packages/mcp/src/tool-adapter.ts wrapMcpToolOutput），这里不做二次包装——
 * 重复包装只会稀释模型对封装边界的理解。
 *
 * 失败隔离：单个 server 连接失败只打印结构化警告到 stderr，绝不中断 CLI 启动；
 * 成功发现的工具与 coding 工具集合并，按工具名由模型自主选择。
 */
import { promises as fs } from "node:fs";
import { createMcpStdioClient, discoverMcpAgentTools } from "@aiagent/mcp";
import type { AgentTool } from "@aiagent/tools";

/** 单个外部 MCP server 的配置（JSON 形状）。 */
export interface McpServerConfig {
  /** server 可读名称（缺省用 command 兜底；用于日志与 /tools 来源标注）。 */
  name?: string;
  /** 启动命令（如 node / npx）。 */
  command: string;
  /** 启动参数。 */
  args?: string[];
  /** 透传给子进程的环境变量。 */
  env?: Record<string, string>;
}

/** --mcp 配置文件的顶层形状。 */
export interface McpConfigFile {
  servers: McpServerConfig[];
}

/** MCP 接线结果。 */
export interface McpToolsResult {
  /** 发现并包装完成的工具，可直接并入 agentLoop 工具集。 */
  tools: AgentTool[];
  /** 成功发现的工具名（/tools 据此标注来源）。 */
  toolNames: string[];
  /** 成功接入的 server 名（欢迎头展示）。 */
  serverNames: string[];
  /** 失败的 server 与结构化错误（不中断启动）。 */
  failures: Array<{ server: string; code: string; message: string }>;
  /**
   * 关闭全部已连接的 stdio client（终止 MCP 子进程）。
   * 必须在 CLI 退出前调用：transport 的子进程管道会保持事件循环存活，
   * 不关闭会导致 REPL 结束后进程无法退出。
   */
  close(): Promise<void>;
}

/**
 * 解析并校验 --mcp 配置文件。
 *
 * @param configPath 配置文件路径。
 * @returns server 配置列表；文件不存在 / JSON 非法 / 形状不符时抛结构化错误。
 */
export async function parseMcpConfig(configPath: string): Promise<McpServerConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`无法读取 MCP 配置文件 ${configPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MCP 配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as { servers?: unknown }) : undefined;
  if (!record || !Array.isArray(record.servers)) {
    throw new Error('MCP 配置缺少 "servers" 数组：{"servers":[{"command","args"?,"env"?,"name"?}]}');
  }
  return record.servers.filter((server): server is McpServerConfig => {
    if (typeof server !== "object" || server === null) return false;
    return typeof (server as { command?: unknown }).command === "string";
  });
}

/**
 * 连接全部配置的 MCP server 并发现工具。
 *
 * @param configPath 配置文件路径。
 * @param onWarn 结构化警告出口（默认 stderr 单行日志）。
 * @returns 工具、工具名、server 名与失败列表。
 */
export async function loadMcpTools(
  configPath: string,
  onWarn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<McpToolsResult> {
  const servers = await parseMcpConfig(configPath);
  const clients: Awaited<ReturnType<typeof createMcpStdioClient>>[] = [];
  const result: McpToolsResult = {
    tools: [],
    toolNames: [],
    serverNames: [],
    failures: [],
    close: async () => {
      for (const client of clients) {
        await client.close().catch(() => undefined);
      }
    },
  };

  for (const server of servers) {
    const name = server.name ?? server.command;
    try {
      const client = await createMcpStdioClient({
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        clientName: name,
      });
      clients.push(client);
      // includeUnknown:true：外部 server 的工具本就未知，宽松透传才能全量并入合并工具集。
      const discovered = await discoverMcpAgentTools(client, { includeUnknown: true });
      if (!discovered.ok) {
        result.failures.push({
          server: name,
          code: discovered.error?.code ?? "mcp_discovery_failed",
          message: discovered.error?.message ?? "MCP 工具发现失败",
        });
        onWarn(`[mcp] server "${name}" 发现工具失败：${discovered.error?.message ?? "未知错误"}`);
        continue;
      }
      result.tools.push(...discovered.tools);
      result.toolNames.push(...discovered.toolNames);
      result.serverNames.push(name);
      // 发现事件写 stderr 单行日志（旁路观测，不打断主流程）。
      onWarn(`[mcp] 已接入 server "${name}"：${discovered.toolNames.join("、") || "（无工具）"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ server: name, code: "mcp_server_unavailable", message });
      onWarn(`[mcp] server "${name}" 连接失败（已跳过）：${message}`);
    }
  }
  return result;
}
