import type { TraceRecorder } from "@aiagent/trace";
import type { LlmChatRequest, LlmChatResponse, LlmClient, LlmError, LlmResult } from "@aiagent/types";

export interface ModelCapabilities { structuredOutput: boolean; toolCalling: boolean; }
export interface ModelCandidate { name: string; client: LlmClient; capabilities: ModelCapabilities; }
export interface ModelRetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number; }
export interface ReliableModelOptions {
  primary: ModelCandidate;
  fallbacks?: ModelCandidate[];
  requiredCapabilities?: Partial<ModelCapabilities>;
  retry?: Partial<ModelRetryPolicy>;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  trace?: TraceRecorder;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}
export interface ReliableModelSuccess { ok: true; data: LlmChatResponse; model: string; degraded: boolean; fallbackReason?: string; attempts: number; }
export type ReliableModelResult = ReliableModelSuccess | { ok: false; error: LlmError; attempts: number; };

const DEFAULT_RETRY: ModelRetryPolicy = { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2_000, jitterRatio: 0.2 };

/** 对模型调用实施临时错误重试、总 deadline 和能力兼容的 fallback。 */
export async function chatWithReliability(request: LlmChatRequest, options: ReliableModelOptions): Promise<ReliableModelResult> {
  const policy = { ...DEFAULT_RETRY, ...options.retry };
  const candidates = [options.primary, ...(options.fallbacks ?? [])].filter((item) => supports(item.capabilities, options.requiredCapabilities));
  let attempts = 0;
  let fallbackReason: string | undefined;
  let lastError: LlmError = { code: "provider_error", message: "No compatible model candidate is available." };
  for (const [candidateIndex, candidate] of candidates.entries()) {
    for (let localAttempt = 1; localAttempt <= policy.maxAttempts; localAttempt += 1) {
      attempts += 1;
      if (options.signal?.aborted) return { ok: false, attempts, error: { code: "request_timeout", message: "Model call cancelled.", details: { terminationReason: "cancelled" } } };
      const remaining = options.deadlineAtMs === undefined ? undefined : options.deadlineAtMs - (options.now ?? Date.now)();
      if (remaining !== undefined && remaining <= 0) return { ok: false, attempts, error: { code: "request_timeout", message: "Model deadline exceeded.", details: { terminationReason: "deadline_exceeded" } } };
      const timeoutMs = resolveAttemptTimeout(request.timeoutMs, remaining);
      // 没有请求级 timeout 或总 deadline 时不写入 Infinity，让 client 保留环境配置的默认超时。
      const result = await candidate.client.chat(timeoutMs === undefined ? request : { ...request, timeoutMs });
      recordModelAttempt(options.trace, candidate.name, attempts, localAttempt, candidateIndex, result, fallbackReason);
      if (result.ok) return { ok: true, data: result.data, model: candidate.name, degraded: candidateIndex > 0, fallbackReason, attempts };
      lastError = result.error;
      if (!isRetryableModelError(lastError)) return { ok: false, error: lastError, attempts };
      if (localAttempt < policy.maxAttempts) {
        try { await (options.sleep ?? defaultSleep)(backoff(localAttempt, policy, options.random ?? Math.random), options.signal); }
        catch { return { ok: false, attempts, error: { code: "request_timeout", message: "Model call cancelled during retry backoff.", details: { terminationReason: "cancelled" } } }; }
      }
    }
    fallbackReason = `${candidate.name}:${lastError.code}`;
  }
  return { ok: false, attempts, error: { ...lastError, details: { ...lastError.details, retryExhausted: true, attempts } } };
}

/** 只有 timeout、网络错误、429 和 5xx provider error 属于可重试临时错误。 */
export function isRetryableModelError(error: LlmError): boolean {
  if (error.code === "request_timeout" || error.code === "network_error") return true;
  const status = typeof error.details?.status === "number" ? error.details.status : undefined;
  return error.code === "provider_error" && (status === 429 || (status !== undefined && status >= 500));
}

/** 判断候选模型是否覆盖本次调用需要的能力。 */
function supports(actual: ModelCapabilities, required: Partial<ModelCapabilities> | undefined): boolean { return (!required?.structuredOutput || actual.structuredOutput) && (!required?.toolCalling || actual.toolCalling); }
/**
 * 合并单次请求超时与剩余总 deadline，未设置时保持 undefined 以免覆盖 client 默认值。
 *
 * @param requestTimeoutMs 单次请求显式超时。
 * @param remainingDeadlineMs 当前 Run 剩余时间。
 * @returns 本次 attempt 应覆盖的有限超时；两者都缺失时返回 undefined。
 */
function resolveAttemptTimeout(
  requestTimeoutMs: number | undefined,
  remainingDeadlineMs: number | undefined
): number | undefined {
  if (requestTimeoutMs === undefined) return remainingDeadlineMs;
  if (remainingDeadlineMs === undefined) return requestTimeoutMs;
  return Math.min(requestTimeoutMs, remainingDeadlineMs);
}
/** 计算带 jitter 的有界指数退避。 */
function backoff(attempt: number, policy: ModelRetryPolicy, random: () => number): number { const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)); return Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * policy.jitterRatio))); }
/** 默认 sleeper 支持取消，测试可注入无等待实现。 */
function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true }); }); }
/** 每次尝试独立写 trace，便于还原 retry 与 fallback 顺序。 */
function recordModelAttempt(trace: TraceRecorder | undefined, model: string, attempt: number, modelAttempt: number, fallbackIndex: number, result: LlmResult<LlmChatResponse>, fallbackReason?: string): void {
  if (!trace) return;
  try { trace.record({ type: "model_call", id: `${trace.traceId}_reliable_model_${attempt}`, traceId: trace.traceId, requestId: trace.requestId, model, purpose: "reliable_chat", durationMs: 0, ok: result.ok, attempt, modelAttempt, fallbackIndex, fallbackReason, error: result.ok ? undefined : result.error, createdAt: new Date().toISOString() }); } catch { /* trace 不影响主调用。 */ }
}
