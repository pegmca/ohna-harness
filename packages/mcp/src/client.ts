import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP tool 摘要，只暴露调用方需要的最小信息：名称、描述和输入 schema。
 *
 * 实际校验交给 MCP server，client adapter 不需要把 JSON schema 转成 zod。
 */
export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP 调用成功结果，内部统一使用 `{ ok: true, result }` 形态，
 * 与 tools package 的 `ToolExecutionSuccess` 对齐。
 */
export interface McpToolCallSuccess {
  ok: true;
  result: unknown;
}

/**
 * MCP 调用失败结果，code 与 message 由 server 返回或 client 边界补充。
 */
export interface McpToolCallFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type McpToolCallResult = McpToolCallSuccess | McpToolCallFailure;

/**
 * MCP client 公共接口，隔离 SDK 具体类型，让上层 adapter 不直接依赖 transport。
 */
export interface McpClient {
  readonly serverName: string;
  /**
   * 通过 MCP 协议列出 server 已注册工具。
   *
   * @returns 工具摘要列表。
   */
  listTools(): Promise<McpToolSummary[]>;
  /**
   * 调用指定 MCP tool，参数校验和错误转换在 server 侧完成。
   *
   * @param name 工具名。
   * @param args 已归一化的参数对象。
   * @returns 结构化成功或失败结果。
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  /**
   * 关闭 transport 连接，释放子进程资源。
   */
  close(): Promise<void>;
}

export interface CreateMcpStdioClientOptions {
  /** 子进程启动命令，默认使用当前 node 可执行文件。 */
  command?: string;
  /** 子进程参数，默认启动本 package 构建后的 stdio server。 */
  args?: string[];
  /** client 名称，用于 MCP 协议握手。 */
  clientName?: string;
  /** client 版本，用于 MCP 协议握手。 */
  clientVersion?: string;
  /**
   * 透传给 stdio 子进程的环境变量，用于向 server 注入数据源等配置。
   * MCP SDK 默认只继承少量安全环境变量，自定义变量（如离线测试替身数据源地址）必须在此显式声明。
   */
  env?: Record<string, string>;
}

/**
 * 创建基于 stdio transport 的 MCP client，并把 SDK 结果映射为内部稳定结构。
 *
 * stdout 专用于 MCP 协议帧，stderr 默认交给子进程自身处理；调用方负责关闭 client。
 *
 * @param options 可选启动命令与 client 身份信息。
 * @returns 可直接调用 tools/call 的 MCP client。
 */
export async function createMcpStdioClient(options: CreateMcpStdioClientOptions = {}): Promise<McpClient> {
  const command = options.command ?? process.execPath;
  const args = options.args ?? [new URL("../dist/stdio.js", import.meta.url).pathname];
  const clientName = options.clientName ?? "aiagent-mcp-client";
  const clientVersion = options.clientVersion ?? "0.1.0";

  const transport = new StdioClientTransport({ command, args, stderr: "pipe", env: options.env });
  const client = new Client({ name: clientName, version: clientVersion });

  await client.connect(transport);

  return {
    serverName: clientName,
    async listTools() {
      const response = await client.listTools();
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>
      }));
    },
    async callTool(name, args) {
      try {
        const response = await client.callTool({ name, arguments: args });
        const structuredContent = (response as Record<string, unknown>).structuredContent;

        if (response.isError) {
          return {
            ok: false,
            error: normalizeMcpError(structuredContent)
          };
        }

        return {
          ok: true,
          result: structuredContent ?? { text: response.content }
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "mcp_client_error",
            message: error instanceof Error ? error.message : "MCP client call failed."
          }
        };
      }
    },
    async close() {
      await client.close();
    }
  };
}

/**
 * 把 MCP server 返回的结构化错误统一成 `{ code, message, details? }` 形态。
 *
 * 当 server 未按约定返回 envelope 时，回退到通用错误码，避免调用方解析异常。
 *
 * @param structuredContent MCP 工具返回的 structuredContent。
 * @returns 规范化错误对象。
 */
function normalizeMcpError(structuredContent: unknown): McpToolCallFailure["error"] {
  if (isRecord(structuredContent) && structuredContent.error && isRecord(structuredContent.error)) {
    const error = structuredContent.error as Record<string, unknown>;
    return {
      code: typeof error.code === "string" ? error.code : "mcp_tool_error",
      message: typeof error.message === "string" ? error.message : "MCP tool returned an error.",
      ...(isRecord(error.details) ? { details: error.details } : {})
    };
  }

  return {
    code: "mcp_tool_error",
    message: "MCP tool returned an error without structured details."
  };
}

/**
 * 判断未知值是否为普通对象，用于安全读取 MCP envelope。
 *
 * @param value 未知值。
 * @returns 是否为 record。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
