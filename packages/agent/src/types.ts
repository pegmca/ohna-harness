import type { LlmClient } from "@aiagent/types";
import type { ToolRegistry } from "@aiagent/tools";
import type { Trace, TraceRecorder } from "@aiagent/trace";

export type AgentIntent = "chat" | "tool" | "report_skill";

export type AgentStepType =
  | "route_intent"
  | "model_answer"
  | "select_tool"
  | "call_tool"
  | "report_skill_placeholder"
  | "final_response"
  | "max_steps_exceeded";

export type AgentStepStatus = "succeeded" | "failed";

export type AgentErrorCode =
  | "empty_message"
  | "max_steps_exceeded"
  | "model_error"
  | "json_parse_error"
  | "tool_error"
  | "tool_not_found"
  | "validation_error"
  | "execution_error"
  | "output_validation_error"
  | "router_error";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentStep {
  index: number;
  type: AgentStepType;
  status: AgentStepStatus;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: AgentError;
}

export interface AgentRequest {
  message: string;
  maxSteps?: number;
}

export interface AgentResponse {
  ok: boolean;
  intent: AgentIntent;
  answer: string;
  traceId: string;
  requestId: string;
  trace: Trace;
  steps: AgentStep[];
  error?: AgentError;
}

export interface AgentToolSelection {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface AgentRoute {
  intent: AgentIntent;
  confidence: number;
  reason: string;
  matchedRules: string[];
  tool?: AgentToolSelection;
}

export interface AgentRouter {
  /**
   * 将用户输入路由到 chat、tool 或 report_skill，避免 Agent Loop 直接散落规则判断。
   *
   * @param message 用户输入。
   * @returns 结构化路由结果。
   */
  route(message: string): Promise<AgentRoute>;
}

export interface AgentConfig {
  llmClient?: LlmClient;
  toolRegistry?: ToolRegistry;
  traceRecorder?: TraceRecorder;
  router?: AgentRouter;
  enableModelRouter?: boolean;
}

export interface Agent {
  /**
   * 执行一次最小 Agent Loop，返回结构化响应、步骤和 trace id。
   *
   * @param request 用户请求。
   * @returns Agent 执行结果。
   */
  run(request: AgentRequest): Promise<AgentResponse>;
}
