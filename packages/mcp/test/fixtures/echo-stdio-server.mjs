// 确定性 in-repo 次级 MCP server（用于演示「外部/社区 server 经同一 AgentTool 契约并入」）。
// 它不依赖网络，注册一个 echo_demo 工具，把输入文本原样回声。
// 仅作为 createCombinedAgentTools({ extraServers }) 的可插拔性 fixture，不进 agentLoop 主路径。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-demo", version: "0.1.0" });

// 注册 echo_demo：inputSchema 用 zod 对象（MCP SDK 1.29 接受 ZodRawShape/AnySchema）。
server.registerTool(
  "echo_demo",
  {
    title: "Echo Demo",
    description: "Echo the input text back as structured content (demo external MCP server).",
    inputSchema: z.object({ text: z.string() })
  },
  async ({ text }) => {
    const data = { ok: true, data: { echoed: text } };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data
    };
  }
);

await server.connect(new StdioServerTransport());
