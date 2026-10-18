/**
 * 本地身份端点：固定 `local-user`。
 *
 * 存在意义是「保险端点」——ohna-web 从 finance-web 复制后可能仍调用
 * `/api/identity/me`；本地模式无鉴权，固定返回一个可用身份，避免 404 导致白屏。
 */
import type { ApiResult, IdentityMeDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId } from "../errors.js";
import type { RouteDeps } from "./types.js";

/** 本地单用户身份 id。 */
export const LOCAL_USER_ID = "local-user";

/**
 * 注册 `GET /api/identity/me`。
 *
 * @param app Fastify 实例。
 * @param _deps 装配上下文（身份固定，不依赖服务）。
 */
export function registerIdentityRoutes(app: FastifyInstance, _deps: RouteDeps): void {
  app.get("/api/identity/me", async (): Promise<ApiResult<IdentityMeDto>> => {
    const requestId = createRequestId();
    return {
      ok: true,
      requestId,
      data: {
        userId: LOCAL_USER_ID,
        createdAt: new Date(0).toISOString(),
        qqBot: { enabled: false, status: "disabled" }
      }
    };
  });
}
