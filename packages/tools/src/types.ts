import type { TraceRecorder } from "@aiagent/trace";
import type { ToolApprovalDecisionDto, ToolApprovalRequestDto, ToolPermissionLevelDto } from "@aiagent/types";
import type { z } from "zod";

export type ToolErrorCode =
  | "tool_not_found"
  | "validation_error"
  | "execution_error"
  | "output_validation_error"
  | "permission_required"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "deadline_exceeded"
  | "retry_exhausted";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  trace?: TraceRecorder;
  approvalDecisions?: ToolApprovalDecisionDto[];
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineAtMs?: number;
  retry?: Partial<ToolRetryPolicy>;
  idempotencyKey?: string;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface ToolRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface ToolExecutionSuccess<TOutput> {
  ok: true;
  toolName: string;
  args: Record<string, unknown>;
  result: TOutput;
  durationMs: number;
  attempts: number;
  traceId?: string;
}

export interface ToolExecutionFailure {
  ok: false;
  toolName: string;
  args: Record<string, unknown>;
  error: ToolError;
  approvalRequest?: ToolApprovalRequestDto;
  durationMs: number;
  attempts: number;
  traceId?: string;
}

export type ToolExecutionResult<TOutput = unknown> = ToolExecutionSuccess<TOutput> | ToolExecutionFailure;

export interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  permissionLevel?: ToolPermissionLevelDto;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /**
   * trace 中使用的工具调用事件类型；MCP tool wrapper 可设置为 `mcp_tool_call`，
   * 使 REST/registry tool call 与 MCP tool call 在 timeline 中可区分。
   */
  traceEventType?: "tool_call" | "mcp_tool_call";
  /** 工具是否有副作用；有副作用工具只有同时声明幂等且提供 idempotency key 才可重试。 */
  hasSideEffects?: boolean;
  /** 声明 execute 在相同幂等键下可安全重放。 */
  idempotent?: boolean;
  /**
   * 对单次工具输入做权限判断；用于 SQL 只读校验、导出动作确认等敏感边界。
   *
   * @param input 已通过 inputSchema 校验的工具参数。
   * @returns 权限等级和面向 reviewer 的原因。
   */
  evaluatePermission?(input: TInput): {
    permissionLevel: ToolPermissionLevelDto;
    reason: string;
    inputPreview?: unknown;
  };
  /**
   * 执行工具真实逻辑，入参已经由 executor 使用 zod 校验。
   *
   * @param input 通过 inputSchema 校验后的工具参数。
   * @returns 工具输出，随后会继续经过 outputSchema 校验。
   */
  execute(input: TInput): TOutput | Promise<TOutput>;
}

export interface ToolRegistrySummary {
  packageName: string;
  availableTools: number;
  toolNames: string[];
}
