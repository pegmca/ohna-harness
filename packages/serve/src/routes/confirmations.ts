/**
 * 确认闸门端点：`POST /api/runs/:runId/confirmations/:toolCallId`。
 *
 * 线协议（03 §6.3）：body `{ decision:"allow"|"deny" }`，成功返回
 * `ApiResult<{toolCallId, decision}>`。这是 Web 端唯一的「副作用放行」入口，
 * 与 `confirmation_requested` 事件一一对应。
 */
import type { ApiResult } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, failure } from "../errors.js";
import type { RouteDeps } from "./types.js";

/** 从请求体读取对象。 */
function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * 注册确认路由。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerConfirmationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // S2：只读观测模式不注册确认写端点——镜像 run 的工具执行发生在 CLI 本地，
  // 浏览器没有可放行的副作用（避免观测台成为隐式审批入口）。
  if (deps.observeOnly) return;

  app.post<{ Params: { runId: string; toolCallId: string } }>(
    "/api/runs/:runId/confirmations/:toolCallId",
    async (request, reply): Promise<ApiResult<{ toolCallId: string; decision: "allow" | "deny" }>> => {
      const requestId = createRequestId();
      if (deps.isShuttingDown()) {
        return failure(reply, requestId, 503, "internal_error", "服务正在关闭，暂时无法确认。");
      }

      const body = asRecord(request.body);
      const decision = body?.decision;
      if (decision !== "allow" && decision !== "deny") {
        return failure(
          reply,
          requestId,
          400,
          "validation_failed",
          "decision 必须是 allow 或 deny。"
        );
      }

      const { runId, toolCallId } = request.params;
      const snapshot = await deps.runtime.getRunSnapshot(runId);
      if (!snapshot) {
        return failure(reply, requestId, 404, "not_found", "Run 不存在。");
      }
      if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled" || snapshot.status === "interrupted") {
        return failure(reply, requestId, 409, "conflict", "Run 已结束，无法再确认。");
      }
      // 自动批准由 serve 选项决定（runtime 不向路由暴露 isAutoApprove，避免双向依赖）。
      if (deps.isAutoApprove) {
        return failure(
          reply,
          requestId,
          409,
          "conflict",
          "已开启自动批准（--auto-approve），写/执行操作无需确认。"
        );
      }

      const result = await deps.runtime.resolveConfirmation(runId, toolCallId, decision);
      if (!result.ok) {
        if (result.code === "not_found") {
          return failure(reply, requestId, 404, "not_found", result.message);
        }
        // 已决 / 自动批准都是「当前状态下不该再提交」。
        return failure(reply, requestId, 409, "conflict", result.message);
      }

      return { ok: true, requestId, data: { toolCallId, decision } };
    }
  );
}
