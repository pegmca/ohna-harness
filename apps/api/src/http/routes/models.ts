import type { ApiResult, ModelCatalogDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import type { ModelRuntimeRegistry } from "../../application/model-registry.js";
import { createRequestId } from "../errors.js";

/**
 * 注册无敏感信息的模型目录端点。
 *
 * @param app Fastify 实例。
 * @param registry 服务端模型目录。
 * @returns 无返回值。
 */
export function registerModelRoutes(app: FastifyInstance, registry: ModelRuntimeRegistry): void {
  app.get("/api/models", async (): Promise<ApiResult<ModelCatalogDto>> => {
    const requestId = createRequestId();
    return { ok: true, requestId, data: registry.catalog() };
  });
}
