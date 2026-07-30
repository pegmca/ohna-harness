/**
 * provider 内请求重试：对齐 pi-ai `src/utils/provider-retry.ts` 的 retryProviderRequest。
 *
 * 复刻 OpenAI/Anthropic SDK 的重试策略，但退避 sleep 可被 AbortSignal 打断
 * （SDK 内置重试计时器忽略请求 signal，因此调用方应以 maxRetries: 0 调 SDK/裸 fetch，
 * 重试统一收在这一个函数里）。
 */

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** 重试选项。 */
interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

/** 带 HTTP 状态与响应头的 provider 错误（裸 fetch 适配层负责构造这个形状）。 */
interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

/**
 * 判断错误是否携带 provider 错误形状（status/headers 字段）。
 * @param error 待判断的错误。
 * @returns 是 ProviderError 返回 true。
 */
function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/**
 * 复刻 SDK 固定重试策略：x-should-retry 头优先，否则 408/409/429/5xx 可重试。
 * @param error provider 错误。
 * @returns 可重试返回 true。
 */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

/**
 * 校验服务端要求的重试等待；超过 maxRetryDelayMs 立即抛错交由上层。
 * @param delayMs 服务端要求的等待毫秒数。
 * @param maxRetryDelayMs 上限（默认 60s；0 表示不限制）。
 * @param providerErrorMessage 原始错误消息（拼进抛出的错误里）。
 * @returns 通过校验的等待毫秒数。
 */
function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

/**
 * 计算第 N 次重试的等待：优先 retry-after-ms / retry-after 响应头，
 * 否则指数退避 0.5*2^n 秒封顶 8 秒，加 25% 负抖动。
 * @param error provider 错误。
 * @param retryIndex 重试序号（从 0 开始）。
 * @param maxRetryDelayMs 服务端要求等待的上限。
 * @returns 等待毫秒数。
 */
function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

/**
 * 构造标准化 AbortError。
 * @returns name 为 "AbortError" 的错误。
 */
function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

/**
 * 可被 AbortSignal 打断的 sleep。
 * @param ms 等待毫秒数。
 * @param signal 可选中断信号。
 * @returns 等待完成 resolve；中断时 reject AbortError。
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 以可中断的指数退避重试一次 provider 请求。
 * 每次重试都是一次全新的请求；中断信号在任意阶段都立即终止。
 *
 * @template T 请求返回类型。
 * @param request 单次请求函数（内部不得自带重试）。
 * @param options 重试选项。
 * @returns 请求成功结果；不可重试或预算耗尽时抛出最后一次错误。
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
