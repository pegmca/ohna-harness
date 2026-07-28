import type { CitationDto, LlmClient } from "@aiagent/types";
import type { ReportPlanDto } from "@aiagent/types";
import type { ToolRegistry } from "@aiagent/tools";
import type { Trace, TraceRecorder } from "@aiagent/trace";
import type { ModelCandidate, ModelCapabilities, ModelRetryPolicy } from "./reliability.js";

export type AgentIntent = "chat" | "tool" | "report_skill";

export type AgentStepType =
  | "route_intent"
  | "model_answer"
  | "select_tool"
  | "call_tool"
  | "report_skill_activation"
  | "report_skill_plan"
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
  | "permission_required"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "deadline_exceeded"
  | "retry_exhausted"
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
  /** 已授权检索 adapter 生成的非可信证据上下文；只用于回答，不参与 intent 路由。 */
  groundingContext?: string;
  /** groundingContext 对应的稳定引用。 */
  groundingCitations?: CitationDto[];
  reportMode?: boolean;
  reportTriggerSource?: "toggle" | "button" | "natural_language";
  maxSteps?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AgentResponse {
  ok: boolean;
  intent: AgentIntent;
  answer: string;
  /** grounded answer 的证据引用；由 API adapter 透传到 run_result 并持久化为 message citations。 */
  citations?: CitationDto[];
  traceId: string;
  requestId: string;
  trace: Trace;
  steps: AgentStep[];
  reportPlan?: ReportPlanDto;
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
  /** true 时 intent router 优先选择 MCP tool 名称（search_filings / get_financial_metrics）。 */
  preferMcpTools?: boolean;
  modelFallbacks?: ModelCandidate[];
  requiredModelCapabilities?: Partial<ModelCapabilities>;
  modelRetry?: Partial<ModelRetryPolicy>;
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
