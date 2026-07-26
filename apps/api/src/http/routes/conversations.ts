import type { IdentitySnapshot } from "@aiagent/identity";
import type {
  ApiResult,
  ConversationDto,
  ConversationMessageDto,
  CreateConversationRequestDto,
  CursorPageDto,
  UpdateConversationRequestDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import type { createConversationApplicationService } from "../../application/conversation-service.js";
import { conversationFailure, createRequestId, fail, toApiError, unavailableConversation } from "../errors.js";
import {
  conversationPageQuerySchema,
  createConversationRequestSchema,
  updateConversationRequestSchema
} from "../schemas.js";

export interface ConversationRoutesDeps {
  identityByRequest: WeakMap<object, IdentitySnapshot>;
  conversationService: ReturnType<typeof createConversationApplicationService> | undefined;
}

/**
 * 注册持久化会话的创建、分页、消息读取与修改路由。
 *
 * @param app Fastify 实例。
 * @param deps 会话应用服务与共享 identity 映射。
 */
export function registerConversationRoutes(app: FastifyInstance, deps: ConversationRoutesDeps): void {
  const { identityByRequest, conversationService } = deps;

  /** 创建当前用户拥有的持久化会话。 */
  app.post("/api/conversations", async (request, reply): Promise<ApiResult<ConversationDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const parsed = createConversationRequestSchema.safeParse(request.body);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    if (!parsed.success) {
      reply.code(400);
      return fail(toApiError("bad_request", "会话标题格式不正确。", requestId), requestId);
    }
    if (!conversationService) return unavailableConversation(reply, requestId);
    try {
      const data = await conversationService.create(identity.userId, parsed.data satisfies CreateConversationRequestDto);
      reply.code(201);
      return { ok: true, data, requestId };
    } catch (error) {
      return conversationFailure(reply, requestId, error);
    }
  });

  /** 以稳定游标读取当前用户的 active 会话。 */
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/api/conversations",
    async (request, reply): Promise<ApiResult<CursorPageDto<ConversationDto>>> => {
      const requestId = createRequestId();
      const identity = identityByRequest.get(request);
      const parsed = conversationPageQuerySchema.safeParse(request.query);
      if (!identity) {
        reply.code(401);
        return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
      }
      if (!parsed.success) {
        reply.code(400);
        return fail(toApiError("bad_request", "会话分页参数不正确。", requestId), requestId);
      }
      if (!conversationService) return unavailableConversation(reply, requestId);
      try {
        const data = await conversationService.list(identity.userId, parsed.data);
        return { ok: true, data, requestId };
      } catch (error) {
        return conversationFailure(reply, requestId, error);
      }
    }
  );

  /** 读取当前用户拥有会话中的终态消息，越权与不存在统一为 not_found。 */
  app.get<{
    Params: { conversationId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/conversations/:conversationId/messages", async (request, reply): Promise<ApiResult<CursorPageDto<ConversationMessageDto>>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const parsed = conversationPageQuerySchema.safeParse(request.query);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    if (!parsed.success) {
      reply.code(400);
      return fail(toApiError("bad_request", "消息分页参数不正确。", requestId), requestId);
    }
    if (!conversationService) return unavailableConversation(reply, requestId);
    try {
      const data = await conversationService.listMessages(identity.userId, {
        conversationId: request.params.conversationId,
        ...parsed.data
      });
      return { ok: true, data, requestId };
    } catch (error) {
      return conversationFailure(reply, requestId, error);
    }
  });

  /** 修改标题或归档当前用户拥有的会话。 */
  app.patch<{ Params: { conversationId: string } }>(
    "/api/conversations/:conversationId",
    async (request, reply): Promise<ApiResult<ConversationDto>> => {
      const requestId = createRequestId();
      const identity = identityByRequest.get(request);
      const parsed = updateConversationRequestSchema.safeParse(request.body);
      if (!identity) {
        reply.code(401);
        return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
      }
      if (!parsed.success) {
        reply.code(400);
        return fail(toApiError("bad_request", "仅支持修改 title 或 archive。", requestId), requestId);
      }
      if (!conversationService) return unavailableConversation(reply, requestId);
      try {
        const data = await conversationService.update(
          identity.userId,
          request.params.conversationId,
          parsed.data satisfies UpdateConversationRequestDto
        );
        return { ok: true, data, requestId };
      } catch (error) {
        return conversationFailure(reply, requestId, error);
      }
    }
  );
}
