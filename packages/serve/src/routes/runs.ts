/**
 * 本地 Run 路由：创建（202）、快照、取消（DELETE）。
 *
 * 线协议严格复用 `@aiagent/types` 的 run-v2 DTO，保证从 finance-web 复制的
 * `run-stream-client.ts` 可以零改动消费。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentRunAcceptedDto,
  ApiResult,
  RunMetaDtoV2,
  RunSnapshotDtoV2
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, failure } from "../errors.js";
import { isValidStoreId } from "../store/index.js";
import type { RouteDeps } from "./types.js";

/** 从请求体读取对象。 */
function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * 注册 Run 路由。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerRunRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /**
   * 创建异步 run；message 非空校验、conversation 不存在时自动建会话。
   * attachments / modelId 在 L0 接受但忽略（单模型 + 只读工具）。
   *
   * S2：只读观测模式（默认 `ohna` 的镜像 serve）不注册本端点——执行权在 CLI 本地，
   * 浏览器不能通过观测台发起 run。
   */
  if (!deps.observeOnly) {
    app.post("/api/runs", async (request, reply): Promise<ApiResult<AgentRunAcceptedDto>> => {
      const requestId = createRequestId();
      if (deps.isShuttingDown()) {
        return failure(reply, requestId, 503, "internal_error", "服务正在关闭，暂时无法接收新的 Run。");
      }
      const body = asRecord(request.body);
      const rawMessage = body?.message;
      if (typeof rawMessage !== "string" || rawMessage.trim() === "") {
        return failure(reply, requestId, 400, "validation_failed", "请输入有效的消息内容。");
      }
      const message = rawMessage.trim();

      const rawConversationId = body?.conversationId;
      if (rawConversationId !== undefined && typeof rawConversationId !== "string") {
        return failure(reply, requestId, 400, "validation_failed", "conversationId 格式不正确。");
      }
      const requestedConversationId =
        typeof rawConversationId === "string" && rawConversationId.trim() !== ""
          ? rawConversationId.trim()
          : undefined;
      if (requestedConversationId && !isValidStoreId(requestedConversationId)) {
        return failure(reply, requestId, 400, "validation_failed", "conversationId 格式不正确。");
      }

      // 会话不存在则自动建：标题取 message 前 40 字。已存在时保留原标题。
      // conversationId 缺省时 runtime 内部会按消息自动建会话（fail-closed 授权 workspaceId）。
      const conversationId = requestedConversationId ?? randomUUID();
      const mode = body?.mode === "report" ? "report" : "auto";
      const source = body?.source === "report_button" ? "report_button" : "composer";
      const result = await deps.runtime.startRun({
        requestId,
        conversationId,
        message,
        mode,
        source,
        workspaceId: deps.workspaceRoot
      });

      // 由 RunStartResultDto 拼装 HTTP 专用受理回执（eventsUrl/snapshotUrl 仅 serve 用）。
      const accepted: AgentRunAcceptedDto = {
        runId: result.accepted.runId,
        requestId: result.accepted.requestId,
        conversationId: result.accepted.conversationId,
        modelId: result.accepted.modelId,
        status: result.accepted.status,
        eventsUrl: `/api/runs/${result.accepted.runId}/events`,
        snapshotUrl: `/api/runs/${result.accepted.runId}`
      };
      reply.code(202);
      return { ok: true, requestId, data: accepted };
    });
  }

  /**
   * 列出某会话下的 run 摘要（观测台 runs 侧栏）。
   *
   * 静态只读：状态由 RunManager 合并「内存态活跃 run → 磁盘事件推导」得到，
   * 因此刚结束的 run 也能直接显示 completed/failed。
   */
  app.get<{ Params: { conversationId: string } }>(
    "/api/conversations/:conversationId/runs",
    async (request, reply): Promise<ApiResult<RunMetaDtoV2[]>> => {
      const requestId = createRequestId();
      const { conversationId } = request.params;
      if (!isValidStoreId(conversationId)) {
        return failure(reply, requestId, 400, "validation_failed", "conversationId 格式不正确。");
      }
      const runs = await deps.runtime.listRunsByConversation(conversationId);
      return { ok: true, requestId, data: runs };
    }
  );

  /** 返回快照：内存活跃 run 优先，否则从 runs JSONL 重建。 */
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request, reply): Promise<ApiResult<RunSnapshotDtoV2>> => {
      const requestId = createRequestId();
      const snapshot = await deps.runtime.getRunSnapshot(request.params.runId);
      if (!snapshot) {
        return failure(reply, requestId, 404, "not_found", "Run 不存在。");
      }
      return { ok: true, requestId, data: snapshot };
    }
  );

  /**
   * 取消 run：abort + 等待收尾 + 落 interrupted；已终态直接返回。
   *
   * S2：只读观测模式不注册——CLI 镜像 run 的取消由 CLI 自己的 Ctrl-C 负责。
   */
  if (!deps.observeOnly) {
    app.delete<{ Params: { runId: string } }>(
      "/api/runs/:runId",
      async (request, reply): Promise<ApiResult<RunSnapshotDtoV2>> => {
        const requestId = createRequestId();
        const snapshot = await deps.runtime.cancelRun(request.params.runId);
        if (!snapshot) {
          return failure(reply, requestId, 404, "not_found", "Run 不存在。");
        }
        return { ok: true, requestId, data: snapshot };
      }
    );
  }
}
