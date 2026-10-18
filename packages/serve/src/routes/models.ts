/**
 * 本地模型目录：单模型目录（L0 不做多模型切换）。
 */
import type { ApiResult, ModelCatalogDto, ModelOptionDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId } from "../errors.js";
import type { RouteDeps } from "./types.js";

/**
 * 把任意 provider 字符串收敛到 DTO 枚举；未知 provider 归入 mock 展示，
 * 避免把未声明枚举泄漏给前端。
 *
 * @param provider 模型 provider。
 * @returns DTO provider。
 */
function toModelProvider(provider: string): ModelOptionDto["provider"] {
  if (provider === "deepseek" || provider === "openrouter" || provider === "bridge_ai" || provider === "mock") {
    return provider;
  }
  return "mock";
}

/**
 * 注册 `GET /api/models`。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/models", async (): Promise<ApiResult<ModelCatalogDto>> => {
    const requestId = createRequestId();
    return { ok: true, requestId, data: deps.modelCatalog };
  });
}

/**
 * 根据当前模型构造单模型目录（server 装配使用）。
 *
 * @param model 当前模型。
 * @returns 模型目录。
 */
export function createSingleModelCatalog(model: RouteDeps["model"]): ModelCatalogDto {
  return {
    defaultModelId: model.id,
    models: [
      {
        id: model.id,
        label: model.name || model.id,
        provider: toModelProvider(model.provider),
        description: `本地模型 · ${model.provider}/${model.id}`,
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true }
      }
    ]
  };
}
