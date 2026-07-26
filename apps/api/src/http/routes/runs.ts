import type { IdentitySnapshot } from "@aiagent/identity";
import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  AgentRunSnapshotDto,
  ApiResult
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import type { createConversationApplicationService } from "../../application/conversation-service.js";
import { createOrderedRunEventStream, isTerminalRunStatus } from "../../application/ordered-run-event-stream.js";
import { RunServiceShuttingDownError, type createRunApplicationService } from "../../application/run-service.js";
import { conversationFailure, createRequestId, fail, toApiError } from "../errors.js";
import { anonymousUserId, requestUserId } from "../hooks/auth.js";
import { agentRunRequestSchema, runEventsQuerySchema } from "../schemas.js";

export interface RunRoutesDeps {
  runService: ReturnType<typeof createRunApplicationService>;
  conversationService: ReturnType<typeof createConversationApplicationService> | undefined;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 Agent run 生命周期路由：创建、快照、取消与 SSE 事件流。
 *
 * @param app Fastify 实例。
 * @param deps Run 用例服务、会话应用服务与共享 identity 映射。
 */
export function registerRunRoutes(app: FastifyInstance, deps: RunRoutesDeps): void {
  const { runService, conversationService, identityByRequest } = deps;

  /** 创建异步研究 run；真实执行在响应返回后开始。 */
  app.post("/api/runs", async (request, reply): Promise<ApiResult<AgentRunAcceptedDto>> => {
    const requestId = createRequestId();
    const parsed = agentRunRequestSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.message.trim()) {
      reply.code(400);
      return fail(toApiError("validation_failed", "请输入有效的研究问题。", requestId, {
        issues: parsed.success ? undefined : parsed.error.issues
      }), requestId);
    }
    const identity = identityByRequest.get(request);
    if (runService.isShuttingDown()) {
      reply.code(503);
      return fail(toApiError("internal_error", "服务正在关闭，暂时无法接收新的研究任务。", requestId, { reasonCode: "run_service_shutting_down" }), requestId);
    }
    if (identity && conversationService && parsed.data.clientMessageId) {
      try {
        await conversationService.persistUserMessage(identity.userId, {
          conversationId: parsed.data.conversationId,
          content: parsed.data.message.trim(),
          clientMessageId: parsed.data.clientMessageId
        });
      } catch (error) {
        return conversationFailure(reply, requestId, error);
      }
    }
    let accepted: AgentRunAcceptedDto;
    try {
      accepted = await runService.create(
        parsed.data satisfies AgentRunCreateRequestDto,
        identity?.userId ?? anonymousUserId
      );
    } catch (error) {
      if (error instanceof RunServiceShuttingDownError) {
        reply.code(503);
        return fail(toApiError("internal_error", "服务正在关闭，暂时无法接收新的研究任务。", requestId, { reasonCode: "run_service_shutting_down" }), requestId);
      }
      throw error;
    }
    reply.code(202);
    return { ok: true, requestId: accepted.requestId, data: accepted };
  });

  /** 返回当前 run 快照，供刷新恢复和非流式诊断使用。 */
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply): Promise<ApiResult<AgentRunSnapshotDto>> => {
    const lookupRequestId = createRequestId();
    const run = await runService.get(requestUserId(identityByRequest, request), request.params.runId);
    if (!run) {
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, requestId: lookupRequestId, data: run };
  });

  /** 显式取消 run；浏览器断开 SSE 不会隐式终止后台任务。 */
  app.delete<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply): Promise<ApiResult<AgentRunSnapshotDto>> => {
    const lookupRequestId = createRequestId();
    const run = await runService.cancel(requestUserId(identityByRequest, request), request.params.runId);
    if (!run) {
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, requestId: lookupRequestId, data: run };
  });

  /** 以 SSE 重放历史事件并继续推送新增事件。 */
  app.get<{ Params: { runId: string }; Querystring: { afterSequence?: string } }>("/api/runs/:runId/events", async (request, reply) => {
    const userId = requestUserId(identityByRequest, request);
    const parsedQuery = runEventsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      reply.code(400);
      const requestId = createRequestId();
      return fail(toApiError("validation_failed", "SSE replay 游标格式不正确。", requestId), requestId);
    }
    const run = await runService.get(userId, request.params.runId);
    if (!run) {
      const requestId = createRequestId();
      reply.code(404);
      return fail(toApiError("not_found", "Agent run 不存在或已过期。", requestId), requestId);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const header = request.headers["last-event-id"];
    const headerSequence = Number(Array.isArray(header) ? header[0] : header ?? 0);
    const afterSequence = Math.max(parsedQuery.data.afterSequence ?? 0, Number.isSafeInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    let unsubscribe = (): void => undefined;
    const stream = createOrderedRunEventStream({
      afterSequence,
      loadAfter: async (sequence) => await runService.listEvents(userId, run.runId, sequence) ?? [],
      write(event) {
        if (!reply.raw.writableEnded) {
          reply.raw.write(`id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
        }
      },
      close() {
        clearInterval(heartbeat);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    });
    await stream.replay(await runService.listEvents(userId, run.runId, afterSequence) ?? []);
    if (stream.isClosed()) return;
    if (isTerminalRunStatus(run.status)) {
      clearInterval(heartbeat);
      reply.raw.end();
      return;
    }
    unsubscribe = runService.subscribe(run.runId, (event) => { void stream.acceptLive(event); });
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // 订阅后再补查一次，覆盖首次 replay 查询与 live subscribe 之间提交的事件。
    await stream.completeCatchUp(await runService.listEvents(userId, run.runId, afterSequence) ?? []);
    if (stream.isClosed()) return;
  });
}
