/**
 * 本地模型目录：单模型目录（L0 不做多模型切换）。
 *
 * v2.0（docs/v2.0/04 §5.6）：条目由「产品能力摘要」扩展为「含成本计量字段」——
 * `contextWindow / maxTokens / cost` 全部从 `RouteDeps["model"]` 投影，**零新增数据来源**。
 * 该通道只服务设置弹窗 / 模型选择器；Trace 读 `llm_call.window`（per-call 快照），不读这里。
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
 * 把模型费率收敛为 DTO 形状：缺失 / 非有限值一律按 0（docs/v2.0/04 §5.6）。
 *
 * 为什么按 0 而不是省略字段：`ModelOptionDto.cost` 冻结为四字段必填（UI 无需判空分支）；
 * mock / bridge 模型没有真实费率时由 UI 依据 0 展示「—」，这是展示决策而非数据缺失。
 *
 * @param cost 模型声明的费率（美元/百万 token），可能缺字段。
 * @returns 四字段齐全的费率。
 */
function toCostDto(cost: Partial<ModelOptionDto["cost"]> | undefined): ModelOptionDto["cost"] {
  const pick = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    input: pick(cost?.input),
    output: pick(cost?.output),
    cacheRead: pick(cost?.cacheRead),
    cacheWrite: pick(cost?.cacheWrite)
  };
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
 * @param model 当前模型（同时是窗口与费率的唯一来源）。
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
        capabilities: { structuredOutput: true, toolCalling: true },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: toCostDto(model.cost)
      }
    ]
  };
}
