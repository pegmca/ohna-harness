/**
 * runtime 边界的结构化错误归一。
 *
 * 跨进程协议（main / preload / utilityProcess / runtime）上的失败统一收敛为
 * `RuntimeErrorDto`：调用方只看到稳定 `code` + 可读 `message` + 关联 `requestId`，
 * 原始异常的内部细节不向外泄漏。本文件不依赖 Fastify / Electron / React，
 * 保持 runtime 包的纯 Node 依赖边界。
 */
import type { RuntimeErrorDto, RuntimeErrorCode } from "@aiagent/types";

/** 协议层归一错误码全集，用于判断未知错误是否需要强制归一到 fallback。 */
const KNOWN_ERROR_CODES: readonly RuntimeErrorCode[] = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "runtime_unavailable",
  "protocol_mismatch",
  "workspace_unavailable",
  "agent_failed",
  "tool_failed",
  "run_interrupted",
  "internal_error",
];

/**
 * 判断候选值是否为合法的归一错误码。
 *
 * @param value 待判断的任意值。
 * @returns 命中错误码全集时为 true。
 */
function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return typeof value === "string" && (KNOWN_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 从未知错误形态中提取可读消息，避免把堆栈或内部对象泄漏给调用方。
 *
 * @param error 任意错误形态。
 * @returns 单行可读消息。
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * 把任意错误形态归一为 `RuntimeErrorDto`。
 *
 * 已带合法 `code` 的错误保留原 code（仅回填 requestId）；其余错误回落到
 * `fallbackCode`，未提供时默认为 `internal_error`。消息一律取自错误本身或
 * `String(error)`，不携带堆栈。
 *
 * @param error 原始错误（Error / 归一错误 / 任意值）。
 * @param requestId 关联请求幂等键，便于日志追踪。
 * @param fallbackCode 未知错误形态时使用的错误码。
 * @returns 归一错误 DTO。
 */
export function toRuntimeError(
  error: unknown,
  requestId: string,
  fallbackCode?: RuntimeErrorCode
): RuntimeErrorDto {
  const fallback: RuntimeErrorCode = fallbackCode ?? "internal_error";
  const code: RuntimeErrorCode =
    error && typeof error === "object" && "code" in error && isRuntimeErrorCode((error as { code: unknown }).code)
      ? (error as { code: RuntimeErrorCode }).code
      : fallback;
  const message = extractMessage(error);
  const details =
    error && typeof error === "object" && "details" in error && (error as { details: unknown }).details &&
    typeof (error as { details: unknown }).details === "object"
      ? (error as { details: Record<string, unknown> }).details
      : undefined;
  return { code, message, requestId, ...(details ? { details } : {}) };
}
