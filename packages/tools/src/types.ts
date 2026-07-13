import type { TraceRecorder } from "@aiagent/trace";
import type { ToolApprovalDecisionDto, ToolApprovalRequestDto, ToolPermissionLevelDto } from "@aiagent/types";
import type { z } from "zod";

export type ToolErrorCode =
  | "tool_not_found"
  | "validation_error"
  | "execution_error"
  | "output_validation_error"
  | "permission_required"
  | "permission_denied";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  trace?: TraceRecorder;
  approvalDecisions?: ToolApprovalDecisionDto[];
}

export interface ToolExecutionSuccess<TOutput> {
  ok: true;
  toolName: string;
  args: Record<string, unknown>;
  result: TOutput;
  durationMs: number;
  traceId?: string;
}

export interface ToolExecutionFailure {
  ok: false;
  toolName: string;
  args: Record<string, unknown>;
  error: ToolError;
  approvalRequest?: ToolApprovalRequestDto;
  durationMs: number;
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
