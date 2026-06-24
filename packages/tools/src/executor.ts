import type { TraceToolCallEvent } from "@aiagent/trace";
import type { ToolRegistry } from "./registry.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";

/**
 * 执行工具的共享入口，保证 Agent、脚本和测试看到相同的错误与 trace 行为。
 *
 * @param registry 工具注册表。
 * @param name 工具名称。
 * @param args 未信任参数。
 * @param context 可选执行上下文。
 * @returns 结构化执行结果。
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  context: ToolExecutionContext = {}
): Promise<ToolExecutionResult> {
  const startedAt = performance.now();
  const normalizedArgs = normalizeArgs(args);
  const tool = registry.get(name);

  if (!tool) {
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      error: {
        code: "tool_not_found",
        message: `Tool not found: ${name}`
      }
    });
  }

  const parsedInput = tool.inputSchema.safeParse(args);

  if (!parsedInput.success) {
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      error: {
        code: "validation_error",
        message: `Invalid arguments for tool: ${name}`,
        details: {
          issues: parsedInput.error.issues
        }
      }
    });
  }

  try {
    const rawOutput = await tool.execute(parsedInput.data);
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);

    if (!parsedOutput.success) {
      return finishToolExecution(context, name, normalizedArgs, startedAt, {
        ok: false,
        toolName: name,
        args: normalizedArgs,
        durationMs: 0,
        traceId: context.trace?.traceId,
        error: {
          code: "output_validation_error",
          message: `Invalid output from tool: ${name}`,
          details: {
            issues: parsedOutput.error.issues
          }
        }
      });
    }

    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: true,
      toolName: name,
      args: normalizedArgs,
      result: parsedOutput.data,
      durationMs: 0,
      traceId: context.trace?.traceId
    });
  } catch (error) {
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      error: {
        code: "execution_error",
        message: error instanceof Error ? error.message : "Tool execution failed"
      }
    });
  }
}

/**
 * 完成执行结果并写入 trace；trace 失败只影响可观测性，不打断主流程。
 *
 * @param context 工具执行上下文。
 * @param toolName 工具名称。
 * @param args 已归一化的参数快照。
 * @param startedAt performance.now 起始值。
 * @param result 初始执行结果。
 * @returns 填充耗时后的执行结果。
 */
function finishToolExecution<TOutput>(
  context: ToolExecutionContext,
  toolName: string,
  args: Record<string, unknown>,
  startedAt: number,
  result: ToolExecutionResult<TOutput>
): ToolExecutionResult<TOutput> {
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const completedResult = {
    ...result,
    durationMs
  };

  if (context.trace) {
    try {
      context.trace.record(toTraceToolCallEvent(context.trace.traceId, context.trace.requestId, toolName, args, completedResult));
    } catch {
      // trace 是旁路观测能力，记录失败不能影响工具主流程。
    }
  }

  return completedResult;
}

/**
 * 将工具执行结果转换成 trace event，保证前端 timeline 有稳定字段可展示。
 *
 * @param traceId 当前请求链路标识。
 * @param requestId 当前请求标识。
 * @param toolName 工具名称。
 * @param args 工具参数快照。
 * @param result 工具执行结果。
 * @returns tool_call trace event。
 */
function toTraceToolCallEvent(
  traceId: string,
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult
): TraceToolCallEvent {
  return {
    type: "tool_call",
    id: `${traceId}_${toolName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    traceId,
    requestId,
    toolName,
    args,
    result: result.ok ? result.result : undefined,
    durationMs: result.durationMs,
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    createdAt: new Date().toISOString()
  };
}

/**
 * 将未知参数转换为可安全记录的对象，避免原始 primitive 破坏 trace 结构。
 *
 * @param args 未信任参数。
 * @returns 可写入 trace 的参数对象。
 */
function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  return {
    value: args
  };
}
