/**
 * 计算模型调用耗时并保留两位小数。
 *
 * @param startedAt performance.now 起始值。
 * @returns 毫秒耗时。
 */
export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

/**
 * 判断未知异常是否是 AbortController 触发的中止错误。
 *
 * @param error 捕获到的未知异常。
 * @returns 如果异常表示请求被 abort 则返回 true。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 将未知异常转换为可放入结构化错误 details 的字符串。
 *
 * @param error 捕获到的未知异常。
 * @returns 可读错误信息。
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断未知值是否是普通对象，供 provider payload 解析和工具参数校验复用。
 *
 * @param value 待检查的未知值。
 * @returns 如果 value 是非数组对象则返回 true。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
