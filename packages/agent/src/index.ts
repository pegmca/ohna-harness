export interface AgentStatus {
  name: string;
  description: string;
  ready: boolean;
}

/**
 * 返回 agent package 当前能力摘要，便于 smoke test 和前端调试台展示。
 *
 * @returns package 状态摘要。
 */
export function createAgentStatus(): AgentStatus {
  return {
    name: "@aiagent/agent",
    description: "Agent package provides LLM client, intent router and minimal agent loop.",
    ready: true
  };
}

export { createAgent, runAgent } from "./agent-loop.js";
export { createIntentRouter, routeIntent } from "./intent-router.js";
export { createLlmClient } from "./llm-client.js";
export { createLlmClientForProfile, createLlmClientFromEnv } from "./llm/env.js";
export { createReportActivation, createReportPlan, isNaturalLanguageReportRequest } from "./report-planner.js";
export { chatWithReliability, isRetryableModelError } from "./reliability.js";
export { assembleUntrustedContext, assessPromptInjection } from "./security.js";
export type { InjectionAssessment, InjectionDecision, UntrustedContent, UntrustedContentSource } from "./security.js";
export type { ModelCandidate, ModelCapabilities, ModelRetryPolicy, ReliableModelOptions, ReliableModelResult } from "./reliability.js";

export type {
  Agent,
  AgentConfig,
  AgentError,
  AgentErrorCode,
  AgentIntent,
  AgentRequest,
  AgentResponse,
  AgentRoute,
  AgentRouter,
  AgentStep,
  AgentStepStatus,
  AgentStepType,
  AgentToolSelection
} from "./types.js";

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
