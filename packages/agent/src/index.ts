export interface AgentStatus {
  name: string;
  description: string;
  ready: boolean;
}

export function createAgentStatus(): AgentStatus {
  return {
    name: "@aiagent/agent",
    description: "Agent package provides the LLM client boundary for future loop work.",
    ready: true
  };
}

export { createLlmClient, createLlmClientFromEnv } from "./llm-client.js";

export type {
  LlmChatOptions,
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmClientConfig,
  LlmError,
  LlmErrorCode,
  LlmJsonChatRequest,
  LlmJsonChatResponse,
  LlmMessage,
  LlmResult,
  LlmRole,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmToolDefinition,
  LlmUsage
} from "@aiagent/types";
