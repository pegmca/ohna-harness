import type { LlmMessage, LlmToolChatRequest } from "@aiagent/types";
import type { OpenAiCompatibleChatMessage } from "./parsing.js";

/**
 * 将内部消息结构映射为 OpenAI compatible message 结构。
 *
 * @param message 内部 LLM 消息。
 * @returns provider 可识别的 chat message。
 */
export function mapMessage(message: LlmMessage): OpenAiCompatibleChatMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId
  };
}

/**
 * 将内部 tool choice 选项映射为 OpenAI compatible tool_choice。
 *
 * @param choice 内部工具选择配置。
 * @returns provider body 中的 tool_choice 字段；未指定时返回 undefined。
 */
export function mapToolChoice(choice: LlmToolChatRequest["toolChoice"]): unknown {
  if (!choice) {
    return undefined;
  }

  if (choice === "auto" || choice === "required") {
    return choice;
  }

  return {
    type: "function",
    function: {
      name: choice.name
    }
  };
}
