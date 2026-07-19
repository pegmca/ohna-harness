import type { TraceMcpToolCallEvent, TraceToolCallEvent } from "@aiagent/trace";
import type { ToolApprovalDecisionDto, ToolApprovalRequestDto, ToolPermissionLevelDto } from "@aiagent/types";
import type { ToolRegistry } from "./registry.js";
import type { Tool, ToolError, ToolExecutionContext, ToolExecutionResult, ToolRetryPolicy } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_POLICY: ToolRetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.2 };
type ToolExecutionDraft<TOutput> =
  | Omit<Extract<ToolExecutionResult<TOutput>, { ok: true }>, "attempts">
  | Omit<Extract<ToolExecutionResult<TOutput>, { ok: false }>, "attempts">;

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
    return finishToolExecution(context, name, normalizedArgs, startedAt, undefined, {
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

  if (context.allowedTools && !context.allowedTools.includes(name)) {
    recordSecurityTrace(context, "block", "SEC_TOOL_NOT_ALLOWLISTED");
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool.traceEventType, {
      ok: false, toolName: name, args: normalizedArgs, durationMs: 0, traceId: context.trace?.traceId,
      error: { code: "permission_denied", message: "Tool is not allowed for this request.", details: { reasonCode: "SEC_TOOL_NOT_ALLOWLISTED" } }
    });
  }

  const parsedInput = tool.inputSchema.safeParse(args);

  if (!parsedInput.success) {
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
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
    recordSecurityTrace(context, "block", "SEC_TOOL_APPROVAL_REJECTED");
    recordApprovalTrace(context, permission.request, "rejected", permission.decision.reviewerNote);
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
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
    recordSecurityTrace(context, "block", permission.request.reasonCode ?? "SEC_TOOL_BLOCKED");
    recordApprovalTrace(context, permission.request, "rejected", "blocked_by_policy");
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
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
    recordSecurityTrace(context, "require_confirmation", permission.request.reasonCode ?? "SEC_TOOL_APPROVAL_REQUIRED");
    recordApprovalTrace(context, permission.request, "requested");
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
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
    recordSecurityTrace(context, "allow", "SEC_TOOL_APPROVAL_VERIFIED");
    recordApprovalTrace(context, permission.request, "approved", permission.decision.reviewerNote);
  }

  const retryPolicy = { ...DEFAULT_RETRY_POLICY, ...context.retry };
  const mayRetry = !tool.hasSideEffects || (tool.idempotent === true && Boolean(context.idempotencyKey));
  let attempts = 0;

  while (attempts < (mayRetry ? retryPolicy.maxAttempts : 1)) {
    attempts += 1;
    const preflightError = getPreflightError(context);
    if (preflightError) {
      return finishToolExecution(context, name, normalizedArgs, startedAt, tool.traceEventType, {
        ok: false, toolName: name, args: normalizedArgs, durationMs: 0, traceId: context.trace?.traceId, error: preflightError
      }, attempts);
    }

    try {
    const rawOutput = await executeWithTimeout(tool, parsedInput.data, context);
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);

    if (!parsedOutput.success) {
      return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
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
      }, attempts);
    }

    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
      ok: true,
      toolName: name,
      args: normalizedArgs,
      result: parsedOutput.data,
      durationMs: 0,
      traceId: context.trace?.traceId
    }, attempts);
  } catch (error) {
    const structured = toToolExecutionError(error);
    if (attempts < retryPolicy.maxAttempts && mayRetry && isRetryableToolError(structured)) {
      const delayMs = calculateBackoff(attempts, retryPolicy);
      try { await (context.sleep ?? defaultSleep)(delayMs, context.signal); }
      catch (sleepError) {
        const cancelled = toToolExecutionError(sleepError);
        return finishToolExecution(context, name, normalizedArgs, startedAt, tool.traceEventType, { ok: false, toolName: name, args: normalizedArgs, durationMs: 0, traceId: context.trace?.traceId, error: cancelled }, attempts);
      }
      continue;
    }
    return finishToolExecution(context, name, normalizedArgs, startedAt, tool?.traceEventType, {
      ok: false,
      toolName: name,
      args: normalizedArgs,
      durationMs: 0,
      traceId: context.trace?.traceId,
      error: {
        ...structured,
        details: { ...structured.details, attempts, retryable: isRetryableToolError(structured), retryExhausted: attempts >= retryPolicy.maxAttempts }
      }
    }, attempts);
  }
  }

  throw new Error("Unreachable tool retry state");
}

/** 在单次 timeout 与总 deadline 中取更小预算，并把取消转换为稳定错误。 */
async function executeWithTimeout<TInput, TOutput>(tool: Tool<TInput, TOutput>, input: TInput, context: ToolExecutionContext): Promise<TOutput> {
  const now = context.now ?? Date.now;
  const remaining = context.deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : context.deadlineAtMs - now();
  const timeoutMs = Math.min(context.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, remaining);
  if (timeoutMs <= 0) throw Object.assign(new Error("Tool deadline exceeded."), { code: "deadline_exceeded" });
  if (context.signal?.aborted) throw Object.assign(new Error("Tool execution cancelled."), { code: "cancelled" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Tool timed out after ${timeoutMs}ms.`), { code: "timeout" })), timeoutMs); });
  const cancelled = context.signal ? new Promise<never>((_, reject) => context.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Tool execution cancelled."), { code: "cancelled" })), { once: true })) : undefined;
  try { return await Promise.race([tool.execute(input), timeout, ...(cancelled ? [cancelled] : [])]); }
  finally { if (timer) clearTimeout(timer); }
}

/** 在真正调用工具前检查取消与总 deadline。 */
function getPreflightError(context: ToolExecutionContext): ToolError | undefined {
  if (context.signal?.aborted) return { code: "cancelled", message: "Tool execution cancelled." };
  if (context.deadlineAtMs !== undefined && (context.now ?? Date.now)() >= context.deadlineAtMs) return { code: "deadline_exceeded", message: "Tool deadline exceeded." };
  return undefined;
}

/** 将工具抛出的未知异常收敛为稳定错误 DTO。 */
function toToolExecutionError(error: unknown): ToolError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "execution_error";
  if (code === "timeout" || code === "cancelled" || code === "deadline_exceeded") return { code, message: error instanceof Error ? error.message : code };
  return { code: "execution_error", message: error instanceof Error ? error.message : "Tool execution failed", details: error && typeof error === "object" && "retryable" in error ? { retryable: error.retryable === true } : undefined };
}

/** 只有明确临时错误才允许进入重试。 */
function isRetryableToolError(error: ToolError): boolean { return error.code === "timeout" || error.code === "deadline_exceeded" || error.details?.retryable === true; }
/** 计算工具调用的有界指数退避。 */
function calculateBackoff(attempt: number, policy: ToolRetryPolicy): number { const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)); return Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * policy.jitterRatio))); }
/** 默认 sleeper 允许 AbortSignal 中断等待。 */
function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("Tool execution cancelled."), { code: "cancelled" })); }, { once: true }); }); }

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
  const requestId = context.trace?.requestId ?? "request_local";
  const inputDigest = createInputDigest(toolName, parsedInput);
  const approvalId = createApprovalId(context.trace?.traceId ?? "trace_local", toolName, inputDigest);
  const request: ToolApprovalRequestDto = {
    approvalId,
    traceId: context.trace?.traceId ?? "trace_local",
    toolName,
    reason,
    inputPreview,
    permissionLevel: level,
    requestId,
    inputDigest,
    reasonCode: evaluated?.reasonCode ?? (level === "blocked" ? "SEC_TOOL_BLOCKED" : level === "needs_approval" ? "SEC_TOOL_APPROVAL_REQUIRED" : "SEC_TOOL_ALLOWED")
  };
  const decision = context.approvalDecisions?.find((item) => item.approvalId === approvalId && item.requestId === requestId && item.inputDigest === inputDigest);

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
function createApprovalId(traceId: string, toolName: string, inputDigest: string): string {
  const serialized = inputDigest;
  let hash = 0;

  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) >>> 0;
  }

  return `approval_${traceId}_${toolName}_${hash.toString(36)}`;
}

/** @param toolName 工具名。 @param input 已校验输入。 @returns 不保存原文的稳定绑定摘要。 */
function createInputDigest(toolName: string, input: unknown): string {
  const serialized = `${toolName}:${stableSerialize(input)}`; let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `input_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** @param value 待规范化值。 @returns key 顺序稳定的 JSON 文本。 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(",")}}`;
  return JSON.stringify(value);
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
      inputDigest: request.inputDigest,
      reasonCode: request.reasonCode,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，权限判断结果不能依赖 trace 成功写入。
  }
}

/** @param context 执行上下文。 @param decision 安全决策。 @param reasonCode 稳定原因码。 */
function recordSecurityTrace(context: ToolExecutionContext, decision: "allow" | "require_confirmation" | "block", reasonCode: string): void {
  try { context.trace?.record({ type: "security", id: `${context.trace.traceId}_tool_security_${Date.now().toString(36)}`, traceId: context.trace.traceId, requestId: context.trace.requestId, category: reasonCode.startsWith("SEC_SQL") ? "sql_readonly" : "tool_permission", decision, reasonCode, createdAt: new Date().toISOString() }); }
  catch { /* 安全判断不依赖旁路 trace 成功。 */ }
}

/**
 * 完成执行结果并写入 trace；trace 失败只影响可观测性，不打断主流程。
 *
 * @param context 工具执行上下文。
 * @param toolName 工具名称。
 * @param args 已归一化的参数快照。
 * @param startedAt performance.now 起始值。
 * @param traceEventType 工具声明的 trace 事件类型；默认 `tool_call`。
 * @param result 初始执行结果。
 * @returns 填充耗时后的执行结果。
 */
function finishToolExecution<TOutput>(
  context: ToolExecutionContext,
  toolName: string,
  args: Record<string, unknown>,
  startedAt: number,
  traceEventType: "tool_call" | "mcp_tool_call" | undefined,
  result: ToolExecutionDraft<TOutput>,
  attempts = 1
): ToolExecutionResult<TOutput> {
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const completedResult = {
    ...result,
    durationMs,
    attempts
  };

  if (context.trace) {
    try {
      context.trace.record(toTraceToolCallEvent(context.trace.traceId, context.trace.requestId, toolName, args, completedResult, traceEventType));
    } catch {
      // trace 是旁路观测能力，记录失败不能影响工具主流程。
    }
  }

  return completedResult;
}

/**
 * 将工具执行结果转换成 trace event；MCP tool wrapper 通过 traceEventType 区分事件类型。
 *
 * @param traceId 当前请求链路标识。
 * @param requestId 当前请求标识。
 * @param toolName 工具名称。
 * @param args 工具参数快照。
 * @param result 工具执行结果。
 * @param traceEventType 可选事件类型；默认 `tool_call`。
 * @returns tool_call 或 mcp_tool_call trace event。
 */
function toTraceToolCallEvent(
  traceId: string,
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
  traceEventType: "tool_call" | "mcp_tool_call" | undefined
): TraceToolCallEvent | TraceMcpToolCallEvent {
  const type = traceEventType ?? "tool_call";
  const base = {
    id: `${traceId}_${toolName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    traceId,
    requestId,
    toolName,
    args,
    result: result.ok ? result.result : undefined,
    durationMs: result.durationMs,
    ok: result.ok,
    attempts: result.attempts,
    error: result.ok ? undefined : result.error,
    createdAt: new Date().toISOString()
  };

  if (type === "mcp_tool_call") {
    return { ...base, type: "mcp_tool_call" };
  }

  return { ...base, type: "tool_call" };
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
