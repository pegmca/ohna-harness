import type { IdentityService, IdentitySnapshot } from "@aiagent/identity";
import type {
  ApiResult,
  IdentityBootstrapRequestDto,
  IdentityMeDto,
  QqBindingChallengeDto,
  QqBindingStatusDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { serializeSessionCookie } from "../cookies.js";
import { createRequestId, fail, toApiError } from "../errors.js";
import { identityBootstrapSchema } from "../schemas.js";

export interface IdentityRoutesDeps {
  identityService: IdentityService;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
  cookieSecure?: boolean;
  qqBotQrUrl?: string;
  qqBotEnabled?: boolean;
  qqBotStatus?: () => IdentityMeDto["qqBot"]["status"];
}

/**
 * 注册身份相关路由：bootstrap、me 与 QQ 绑定。
 *
 * @param app Fastify 实例。
 * @param deps 身份服务与 QQ 渠道展示配置。
 */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  const { identityService, identityByRequest } = deps;

  /** 首次访问通过浏览器指纹创建/恢复 userId，并以 HttpOnly cookie 保存 session。 */
  app.post("/api/identity/bootstrap", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const parsed = identityBootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail(toApiError("validation_failed", "浏览器指纹格式不正确。", requestId, { issues: parsed.error.issues }), requestId);
    }
    const created = await identityService.bootstrap(
      (parsed.data satisfies IdentityBootstrapRequestDto).visitorId,
      parsed.data.fingerprintVersion
    );
    reply.header("set-cookie", serializeSessionCookie(created.token, created.expiresAt, deps.cookieSecure ?? process.env.NODE_ENV === "production"));
    return { ok: true, requestId, data: toIdentityMeDto(created.snapshot, deps) };
  });

  /** 返回当前 session 对应的稳定 userId 与 QQ 绑定状态。 */
  app.get("/api/identity/me", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    return { ok: true, requestId, data: toIdentityMeDto(identity, deps) };
  });

  /** 为当前 userId 生成 QQ 私聊绑定码。 */
  app.post("/api/identity/qq-binding-challenges", async (request, reply): Promise<ApiResult<QqBindingChallengeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    if (!deps.qqBotEnabled) {
      reply.code(503);
      return fail(toApiError("internal_error", "QQ Bot 尚未配置。", requestId, { reasonCode: "qq_bot_not_configured" }), requestId);
    }
    if (identity.qqIdentity) {
      reply.code(409);
      return fail(toApiError("conflict", "当前 userId 已绑定 QQ。", requestId), requestId);
    }
    const challenge = await identityService.createQqBindingChallenge(identity.userId);
    return {
      ok: true,
      requestId,
      data: {
        challengeId: challenge.challengeId,
        code: challenge.code,
        command: `/bind ${challenge.code}`,
        expiresAt: challenge.expiresAt,
        botQrUrl: deps.qqBotQrUrl
      }
    };
  });

  /** 供 Settings 轮询 QQ 命令是否已经消费绑定码。 */
  app.get<{ Params: { challengeId: string } }>("/api/identity/qq-binding-challenges/:challengeId", async (request, reply): Promise<ApiResult<QqBindingStatusDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    const status = await identityService.getQqBindingStatus(request.params.challengeId, identity.userId);
    const qqIdentity = status === "bound" ? await identityService.repository.getQqIdentityByUserId(identity.userId) : undefined;
    return {
      ok: true,
      requestId,
      data: {
        challengeId: request.params.challengeId,
        status,
        qqIdentity: qqIdentity ? { botAccountId: qqIdentity.botAccountId, boundAt: qqIdentity.boundAt } : undefined
      }
    };
  });

  /** 从当前 Web 身份解除 QQ 绑定。 */
  app.delete("/api/identity/qq-identity", async (request, reply): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    if (!identity) {
      reply.code(401);
      return fail(toApiError("unauthorized", "身份 session 无效。", requestId), requestId);
    }
    await identityService.unbindQq(identity.userId);
    const user = await identityService.repository.getUser(identity.userId);
    if (!user) {
      reply.code(404);
      return fail(toApiError("not_found", "用户不存在。", requestId), requestId);
    }
    return {
      ok: true,
      requestId,
      data: toIdentityMeDto({ userId: user.userId, createdAt: user.createdAt }, deps)
    };
  });
}

/**
 * 把领域身份映射成不暴露 QQ OpenID 的公共 DTO。
 *
 * @param identity 服务端确认的身份。
 * @param options QQ 渠道展示配置。
 * @returns Web 可消费的身份 DTO。
 */
function toIdentityMeDto(identity: IdentitySnapshot, options: Pick<IdentityRoutesDeps, "qqBotEnabled" | "qqBotStatus">): IdentityMeDto {
  return {
    userId: identity.userId,
    createdAt: identity.createdAt,
    qqIdentity: identity.qqIdentity
      ? { botAccountId: identity.qqIdentity.botAccountId, boundAt: identity.qqIdentity.boundAt }
      : undefined,
    qqBot: {
      enabled: options.qqBotEnabled ?? false,
      status: options.qqBotStatus?.() ?? (options.qqBotEnabled ? "stopped" : "disabled")
    }
  };
}
