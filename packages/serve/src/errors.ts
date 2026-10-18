/**
 * HTTP 边界的统一错误与请求标识。
 *
 * 约束：所有非 SSE 响应必须是 `ApiResult`；错误只暴露稳定 code + 可读 message + requestId，
 * 原始异常（数据库/文件系统细节）不进入响应体。SSE 路由在 hijack 后由自身负责关闭，
 * 走不到 Fastify 的 errorHandler。
 */
import { randomUUID } from "node:crypto";
import type { ApiErrorCode, ApiResult } from "@aiagent/types";
import { redactSensitiveValue } from "@aiagent/trace";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * 生成一次 HTTP 请求的稳定标识。
 *
 * @returns UUID。
 */
export function createRequestId(): string {
  return randomUUID();
}

/**
 * 构造 ApiResult 失败分支并设置 HTTP 状态码。
 *
 * @template TData 成功分支数据类型。
 * @param reply Fastify 响应。
 * @param requestId 请求 id。
 * @param status HTTP 状态码。
 * @param code 稳定错误码。
 * @param message 用户可读错误。
 * @param details 可选诊断信息（会脱敏）。
 * @returns ApiResult 失败分支。
 */
export function failure<TData>(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApiResult<TData> {
  reply.code(status);
  return {
    ok: false,
    requestId,
    error: {
      code,
      message,
      requestId,
      ...(details ? { details: redactSensitiveValue(details) } : {})
    }
  };
}

/**
 * 注册全局错误处理：4xx 使用稳定文案，5xx 隐藏原始异常。
 *
 * @param app Fastify 实例。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const requestId = createRequestId();
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" && rawStatus >= 400 ? rawStatus : 500;
    const code: ApiErrorCode = statusCode >= 500 ? "internal_error" : "bad_request";
    const message =
      statusCode === 413
        ? "请求体过大。"
        : statusCode >= 500
          ? "服务端处理请求失败。"
          : "请求格式不正确。";
    reply.code(statusCode).send({
      ok: false,
      requestId,
      error: { code, message, requestId }
    } satisfies ApiResult<never>);
  });
}

/**
 * 解析分页 limit（正整数，上限 200）。
 *
 * @param raw 查询字符串。
 * @param fallback 默认值。
 * @returns 合法 limit。
 */
export function parseLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 200) : fallback;
}

/**
 * 解析序列游标（非负整数）。
 *
 * @param raw 查询字符串。
 * @returns 合法游标；非法返回 undefined。
 */
export function parseSequenceCursor(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
