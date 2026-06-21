import type { TraceRecorder } from "@aiagent/trace";
import type { z } from "zod";

export type ToolErrorCode = "tool_not_found" | "validation_error" | "execution_error" | "output_validation_error";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  trace?: TraceRecorder;
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
  durationMs: number;
  traceId?: string;
}

export type ToolExecutionResult<TOutput = unknown> = ToolExecutionSuccess<TOutput> | ToolExecutionFailure;

export interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
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
