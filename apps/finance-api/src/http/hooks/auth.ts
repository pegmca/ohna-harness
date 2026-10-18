import type { IdentityService, IdentitySnapshot } from "@aiagent/identity";
import type { FastifyInstance } from "fastify";
import { readCookie } from "../cookies.js";
import { createRequestId, fail, toApiError } from "../errors.js";

export const anonymousUserId = "00000000-0000-0000-0000-000000000000";

/** @param identityByRequest composition 共享的 request→identity 映射。 @param request Fastify request 对象。 @returns 已认证用户或测试兼容匿名用户。 */
export const requestUserId = (identityByRequest: WeakMap<object, IdentitySnapshot>, request: object): string =>
  identityByRequest.get(request)?.userId ?? anonymousUserId;

export interface AuthHookDeps {
  identityService: IdentityService;
  requireIdentity?: boolean;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册统一 session 解析 preHandler 钩子，使业务 route 只能读取服务端确认的 userId。
 * 生产 server 开启 requireIdentity；测试可注入身份服务并逐步验证旧 route。
 *
 * @param app Fastify 实例。
 * @param deps 身份服务、requireIdentity 开关与共享 identity 映射。
 */
export function registerAuthHook(app: FastifyInstance, deps: AuthHookDeps): void {
  const { identityService, identityByRequest } = deps;
  app.addHook("preHandler", async (request, reply) => {
    const isPublic = request.url === "/health"
      || request.url === "/ready"
      || request.url === "/api/identity/bootstrap";
    if (isPublic) return;
    let identity: IdentitySnapshot | undefined;
    try {
      identity = await identityService.authenticate(readCookie(request.headers.cookie, "aiagent_session"));
    } catch (error) {
      // session 查询依赖数据库；故障时必须 fail-closed 且只返回稳定信封，
      // 不能让 pg 原始异常（连接地址、错误码）经 Fastify 默认序列化泄漏给客户端。
      app.log.warn({ err: error }, "identity authenticate failed");
      const requestId = createRequestId();
      reply.code(503).send(fail(toApiError("internal_error", "身份服务暂时不可用，请稍后重试。", requestId), requestId));
      return;
    }
    if (identity) {
      identityByRequest.set(request, identity);
      return;
    }
    if (deps.requireIdentity || request.url.startsWith("/api/identity/")) {
      const requestId = createRequestId();
      reply.code(401).send(fail(toApiError("unauthorized", "身份 session 无效，请重新识别浏览器。", requestId), requestId));
    }
  });
}
