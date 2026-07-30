/**
 * withTimeoutAndRetry：旧 executor（executor.ts:145–240）超时/重试/deadline 语义的迁移形态。
 * approval 权限门与 trace 记录已删除（权限体系整体移除；观测改由 agent loop 的
 * tool_execution_* 事件承担），这里只保留「单次 timeout ∩ 总 deadline 预算 +
 * 指数退避重试 + AbortSignal 取消」这一纯函数包装，作为 AgentTool.execute 的内部 helper。
 */
import type { ToolError, ToolErrorCode, ToolExecutionOptions, ToolRetryPolicy } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_POLICY: ToolRetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.2 };

/**
 * 用「单次超时 ∩ 剩余 deadline」预算执行 fn，并按策略对临时错误做指数退避重试。
 * 失败一律抛带 code 的 Error（结构化错误），由 loop 层转成 isError 的 ToolResultMessage。
 *
 * @param fn 被包装的执行体；收到与调用方一致的 AbortSignal。
 * @param options 超时/deadline/重试/取消选项。
 * @returns fn 的返回值。
 */
export async function withTimeoutAndRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T> | T,
  options: ToolExecutionOptions = {},
): Promise<T> {
  const retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const mayRetry = !options.hasSideEffects || (options.idempotent === true && Boolean(options.idempotencyKey));
  let attempts = 0;

  while (attempts < (mayRetry ? retryPolicy.maxAttempts : 1)) {
    attempts += 1;
    const preflightError = getPreflightError(options);
    if (preflightError) {
      throw preflightError;
    }

    try {
      return await executeWithTimeout(fn, options);
    } catch (error) {
      const structured = toToolExecutionError(error);
      if (attempts < retryPolicy.maxAttempts && mayRetry && isRetryableToolError(structured)) {
        const delayMs = calculateBackoff(attempts, retryPolicy);
        // sleep 被 abort 时把取消错误直接抛给调用方，不再进入下一次重试。
        await (options.sleep ?? defaultSleep)(delayMs, options.signal);
        continue;
      }
      if (attempts > 1 || isRetryableToolError(structured)) {
        // 补充重试诊断信息，便于上层区分「一次失败」与「重试耗尽」。
        throw withErrorDetails(structured, {
          ...structured.details,
          attempts,
          retryExhausted: attempts >= retryPolicy.maxAttempts,
        });
      }
      throw withErrorDetails(structured, structured.details);
    }
  }

  throw createToolError("retry_exhausted", "Unreachable tool retry state");
}

/** 在单次 timeout 与总 deadline 中取更小预算，并把取消转换为稳定错误。 */
async function executeWithTimeout<T>(fn: (signal?: AbortSignal) => Promise<T> | T, options: ToolExecutionOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const remaining = options.deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : options.deadlineAtMs - now();
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, remaining);
  if (timeoutMs <= 0) throw createToolError("deadline_exceeded", "Tool deadline exceeded.");
  if (options.signal?.aborted) throw createToolError("cancelled", "Tool execution cancelled.");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(createToolError("timeout", `Tool timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  const cancelled = options.signal
    ? new Promise<never>((_, reject) =>
        options.signal?.addEventListener("abort", () => reject(createToolError("cancelled", "Tool execution cancelled.")), { once: true }),
      )
    : undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => fn(options.signal)), timeout, ...(cancelled ? [cancelled] : [])]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 在真正调用工具前检查取消与总 deadline。 */
function getPreflightError(options: ToolExecutionOptions): Error | undefined {
  if (options.signal?.aborted) return createToolError("cancelled", "Tool execution cancelled.");
  if (options.deadlineAtMs !== undefined && (options.now ?? Date.now)() >= options.deadlineAtMs) {
    return createToolError("deadline_exceeded", "Tool deadline exceeded.");
  }
  return undefined;
}

/** 构造带稳定 code 的 Error；details 挂在 error.details 上。 */
function createToolError(code: ToolErrorCode, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

/** 把结构化错误重新打包为带补充 details 的 Error。 */
function withErrorDetails(error: ToolError, details: Record<string, unknown> | undefined): Error {
  return createToolError(error.code, error.message, details);
}

/** 允许穿透包装层的稳定错误码；其余一律收敛为 execution_error。 */
const PRESERVED_ERROR_CODES = new Set<ToolErrorCode>([
  "timeout",
  "cancelled",
  "deadline_exceeded",
  "validation_error",
  "output_validation_error",
  "permission_denied",
  "tool_not_found",
]);

/** 将工具抛出的未知异常收敛为稳定错误码；白名单内的 code 原样保留。 */
function toToolExecutionError(error: unknown): ToolError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "execution_error";
  if (PRESERVED_ERROR_CODES.has(code as ToolErrorCode)) {
    return {
      code: code as ToolErrorCode,
      message: error instanceof Error ? error.message : code,
      details: error && typeof error === "object" && "details" in error ? (error as { details?: Record<string, unknown> }).details : undefined,
    };
  }
  return {
    code: "execution_error",
    message: error instanceof Error ? error.message : "Tool execution failed",
    details: error && typeof error === "object" && "retryable" in error ? { retryable: (error as { retryable?: unknown }).retryable === true } : undefined,
  };
}

/** 只有明确临时错误才允许进入重试。 */
function isRetryableToolError(error: ToolError): boolean {
  return error.code === "timeout" || error.code === "deadline_exceeded" || error.details?.retryable === true;
}

/** 计算工具调用的有界指数退避。 */
function calculateBackoff(attempt: number, policy: ToolRetryPolicy): number {
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.max(0, Math.round(base * 1 + (Math.random() * 2 - 1) * policy.jitterRatio * base));
}

/** 默认 sleeper 允许 AbortSignal 中断等待。 */
function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(createToolError("cancelled", "Tool execution cancelled."));
      },
      { once: true },
    );
  });
}
