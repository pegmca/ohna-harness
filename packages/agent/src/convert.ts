/**
 * zod → JSON Schema 桥 + 默认 convertToLlm。
 * toLlmTools 是 AgentTool(zod) → LLM Tool(JSON Schema) 的唯一转换点：
 * loop 内部与落库始终持 zod，只有组装 LLM Context 时才序列化。
 */
import type { Message, Tool } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import type { AgentMessage } from "./types.js";

/**
 * 把 AgentTool[] 转成 LLM 请求用的 Tool[]（parameters 变为 JSON Schema 对象）。
 * 在 streamAssistantResponse 组装 llmContext 时调用，是全仓库唯一的 zod→JSON Schema 转换点。
 *
 * @param tools AgentTool 列表（zod schema）。
 * @returns 可放进 LLM Context.tools 的 Tool 列表。
 */
export function toLlmTools(tools: AgentTool<any>[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
  }));
}

/**
 * 默认 convertToLlm：标准三元组原样透传；CompactionMessage 转成一条 user 消息
 * （对齐 pi buildSessionContext 把 compaction summary 作为上下文开头 user 消息的做法）。
 *
 * @param messages AgentMessage 序列。
 * @returns LLM 可消费的三元组消息序列。
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.map((message) => {
    if (message.role === "compaction") {
      return {
        role: "user",
        content: `[以下是之前对话历史的压缩摘要]\n\n${message.summary}`,
        timestamp: message.timestamp,
      };
    }
    return message;
  });
}
