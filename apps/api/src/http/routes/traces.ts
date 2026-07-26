import type { IdentitySnapshot } from "@aiagent/identity";
import type { TraceStore } from "@aiagent/trace";
import type { ApiResult, TraceDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, fail, toApiError } from "../errors.js";
import { requestUserId } from "../hooks/auth.js";

export interface TraceRoutesDeps {
  traceStore: TraceStore;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 Trace 查询路由。
 *
 * @param app Fastify 实例。
 * @param deps Trace store 与共享 identity 映射。
 */
export function registerTraceRoutes(app: FastifyInstance, deps: TraceRoutesDeps): void {
  const { traceStore, identityByRequest } = deps;

  /** 按当前 session user 和对外 requestId 返回持久化脱敏 Trace。 */
  app.get<{ Params: { requestId: string } }>("/api/traces/:requestId", async (request, reply): Promise<ApiResult<TraceDto>> => {
    const lookupRequestId = createRequestId();
    const trace = await traceStore.getByRequestId(requestUserId(identityByRequest, request), request.params.requestId);
    if (!trace) {
      reply.code(404);
      return fail(toApiError("not_found", "Trace 不存在。", lookupRequestId), lookupRequestId);
    }
    return { ok: true, data: trace, requestId: lookupRequestId };
  });
}
