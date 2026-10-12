/**
 * bridge provider 配置读取（共享契约）。
 *
 * 本仓库的"生产级真实 provider"统一走私有 OpenAI 兼容端点（AIAGENT_LLM_*_BRIDGE_AI）。
 * 所有真实 embedding / rerank / LLM-judge 客户端都从这里读取同一组环境变量，
 * 避免每个实现各读一套、命名漂移；无 key 时 enabled=false，调用方回退到 mock/fixture。
 *
 * 生产维度约定：真实 embedding 默认 1536 维，与 database 侧向量列迁移保持一致；
 * 调小需同步 migration，pgvector 列维度在创建时固定。
 */

/** 生产默认 embedding 维度，需与 packages/database 的向量列迁移一致。 */
export const DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS = 1536;

/** bridge 端点相关环境变量名。 */
export const BRIDGE_ENV = {
  baseUrl: "AIAGENT_LLM_BASE_URL_BRIDGE_AI",
  apiKey: "AIAGENT_LLM_API_KEY_BRIDGE_AI",
  model: "AIAGENT_LLM_MODEL_BRIDGE_AI",
  embeddingModel: "AIAGENT_LLM_EMBEDDING_MODEL_BRIDGE_AI",
  embeddingDimensions: "AIAGENT_LLM_EMBEDDING_DIMENSIONS_BRIDGE_AI",
  rerankModel: "AIAGENT_LLM_RERANK_MODEL_BRIDGE_AI"
} as const;

/**
 * bridge 通用配置（chat / 判定类调用）。
 */
export interface BridgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否具备真实调用条件（baseUrl 与 apiKey 同时非空）。 */
  enabled: boolean;
}

/**
 * 读取 bridge 通用配置。
 *
 * @returns baseUrl、apiKey、model 与 enabled 标记；缺环境变量时 enabled 为 false。
 */
export function readBridgeConfig(): BridgeConfig {
  const baseUrl = process.env[BRIDGE_ENV.baseUrl]?.trim() ?? "";
  const apiKey = process.env[BRIDGE_ENV.apiKey]?.trim() ?? "";
  const model = process.env[BRIDGE_ENV.model]?.trim() ?? "hy3-x";
  return {
    baseUrl,
    apiKey,
    model,
    enabled: baseUrl.length > 0 && apiKey.length > 0
  };
}

/**
 * bridge embedding 配置（/v1/embeddings）。
 */
export interface BridgeEmbeddingConfig extends BridgeConfig {
  embeddingModel: string;
  dimensions: number;
}

/**
 * 读取 bridge embedding 配置。
 *
 * embedding 模型默认复用通用 model；维度默认 1536，可由环境变量覆盖。
 *
 * @returns embedding 端点配置与启用标记。
 */
export function readBridgeEmbeddingConfig(): BridgeEmbeddingConfig {
  const base = readBridgeConfig();
  const embeddingModel = process.env[BRIDGE_ENV.embeddingModel]?.trim() || base.model;
  const dimensionsRaw = process.env[BRIDGE_ENV.embeddingDimensions]?.trim();
  const dimensions = dimensionsRaw ? Number.parseInt(dimensionsRaw, 10) : DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS;
  return {
    ...base,
    embeddingModel,
    dimensions: Number.isInteger(dimensions) && dimensions > 0 ? dimensions : DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS
  };
}

/**
 * bridge rerank 配置（/v1/rerank 或回退到 LLM-judge）。
 */
export interface BridgeRerankConfig extends BridgeConfig {
  rerankModel: string;
}

/**
 * 读取 bridge rerank 配置。
 *
 * @returns rerank 端点配置与启用标记。
 */
export function readBridgeRerankConfig(): BridgeRerankConfig {
  const base = readBridgeConfig();
  const rerankModel = process.env[BRIDGE_ENV.rerankModel]?.trim() || base.model;
  return {
    ...base,
    rerankModel
  };
}
