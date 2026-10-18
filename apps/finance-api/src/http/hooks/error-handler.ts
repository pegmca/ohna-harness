import type { FastifyInstance } from "fastify";
import { createRequestId, fail, toApiError } from "../errors.js";

/**
 * 注册兜底错误处理：任何未被路由显式映射的异常统一为稳定信封，不序列化原始 message/code。
 *
 * @param app Fastify 实例。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    app.log.error({ err: error, url: request.url }, "unhandled route error");
    const requestId = createRequestId();
    void reply.code(500).send(fail(toApiError("internal_error", "服务暂时不可用，请稍后重试。", requestId), requestId));
  });
}
