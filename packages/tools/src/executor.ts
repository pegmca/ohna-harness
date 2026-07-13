import type { TraceToolCallEvent } from "@aiagent/trace";
import type { ToolApprovalDecisionDto, ToolApprovalRequestDto, ToolPermissionLevelDto } from "@aiagent/types";
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

  const permission = evaluateToolPermission(tool, parsedInput.data, name, normalizedArgs, context);

  if (permission.decision?.decision === "rejected") {
    recordApprovalTrace(context, permission.request, "rejected", permission.decision.reviewerNote);
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      approvalRequest: permission.request,
      error: {
        code: "permission_denied",
        message: `Tool execution rejected: ${name}`,
        details: {
          approvalId: permission.request.approvalId,
          permissionLevel: permission.request.permissionLevel
        }
      }
    });
  }

  if (permission.level === "blocked") {
    recordApprovalTrace(context, permission.request, "rejected", "blocked_by_policy");
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      approvalRequest: permission.request,
      error: {
        code: "permission_denied",
        message: permission.request.reason,
        details: {
          approvalId: permission.request.approvalId,
          permissionLevel: permission.request.permissionLevel
        }
      }
    });
  }

  if (permission.level === "needs_approval" && permission.decision?.decision !== "approved") {
    recordApprovalTrace(context, permission.request, "requested");
    return finishToolExecution(context, name, normalizedArgs, startedAt, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      approvalRequest: permission.request,
      error: {
        code: "permission_required",
        message: `Tool requires approval before execution: ${name}`,
        details: {
          approvalId: permission.request.approvalId,
          permissionLevel: permission.request.permissionLevel
        }
      }
    });
  }

  if (permission.decision?.decision === "approved") {
    recordApprovalTrace(context, permission.request, "approved", permission.decision.reviewerNote);
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
 * 在工具真实执行前集中判断权限，确保 Agent、Workflow 和测试都经过同一个 approval gate。
 *
 * @param tool 工具定义。
 * @param parsedInput 已校验输入。
 * @param toolName 工具名称。
 * @param normalizedArgs 参数快照。
 * @param context 工具执行上下文。
 * @returns 权限判断、审批请求和已有审批决定。
 */
function evaluateToolPermission(
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  parsedInput: unknown,
  toolName: string,
  normalizedArgs: Record<string, unknown>,
  context: ToolExecutionContext
): {
  level: ToolPermissionLevelDto;
  request: ToolApprovalRequestDto;
  decision?: ToolApprovalDecisionDto;
} {
  const evaluated = tool.evaluatePermission?.(parsedInput as never);
  const level = evaluated?.permissionLevel ?? tool.permissionLevel ?? "safe";
  const reason = evaluated?.reason ?? defaultPermissionReason(level, toolName);
  const inputPreview = evaluated?.inputPreview ?? createInputPreview(normalizedArgs);
  const approvalId = createApprovalId(context.trace?.traceId ?? "trace_local", toolName, inputPreview);
  const request: ToolApprovalRequestDto = {
    approvalId,
    traceId: context.trace?.traceId ?? "trace_local",
    toolName,
    reason,
    inputPreview,
    permissionLevel: level
  };
  const decision = context.approvalDecisions?.find((item) => item.approvalId === approvalId);

  return {
    level,
    request,
    decision
  };
}

/**
 * 生成权限判断默认说明，避免 metadata 缺失时 reviewer 看不到原因。
 *
 * @param level 权限等级。
 * @param toolName 工具名称。
 * @returns 可读原因。
 */
function defaultPermissionReason(level: ToolPermissionLevelDto, toolName: string): string {
  if (level === "safe") {
    return `${toolName} is classified as safe.`;
  }

  if (level === "blocked") {
    return `${toolName} is blocked by tool permission policy.`;
  }

  return `${toolName} requires human approval before execution.`;
}

/**
 * 生成可写入 trace 的输入摘要，避免完整 SQL、文档正文或导出 payload 进入审批事件。
 *
 * @param args 工具参数。
 * @returns 输入摘要。
 */
function createInputPreview(args: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      preview[key] = value.length > 120 ? `${value.slice(0, 117)}...` : value;
    } else if (Array.isArray(value)) {
      preview[key] = {
        itemCount: value.length
      };
    } else if (value && typeof value === "object") {
      preview[key] = {
        keys: Object.keys(value).slice(0, 8)
      };
    } else {
      preview[key] = value;
    }
  }

  return preview;
}

/**
 * 创建稳定 approval id，同一 trace、工具和输入摘要会得到相同 id，便于审批后重放执行。
 *
 * @param traceId trace id。
 * @param toolName 工具名称。
 * @param inputPreview 输入摘要。
 * @returns approval id。
 */
function createApprovalId(traceId: string, toolName: string, inputPreview: unknown): string {
  const serialized = JSON.stringify(inputPreview);
  let hash = 0;

  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) >>> 0;
  }

  return `approval_${traceId}_${toolName}_${hash.toString(36)}`;
}

/**
 * 写入 approval trace event；只记录 request preview 和 reviewer note，不保存敏感完整 payload。
 *
 * @param context 工具执行上下文。
 * @param request 审批请求。
 * @param status 审批状态。
 * @param reviewerNote 可选 reviewer 说明。
 */
function recordApprovalTrace(
  context: ToolExecutionContext,
  request: ToolApprovalRequestDto,
  status: "requested" | "approved" | "rejected",
  reviewerNote?: string
): void {
  if (!context.trace) {
    return;
  }

  try {
    context.trace.record({
      type: "approval",
      id: `${context.trace.traceId}_${request.approvalId}_${status}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      traceId: context.trace.traceId,
      requestId: context.trace.requestId,
      approvalId: request.approvalId,
      toolName: request.toolName,
      status,
      reason: request.reason,
      inputPreview: request.inputPreview,
      reviewerNote,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，权限判断结果不能依赖 trace 成功写入。
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
