/**
 * provider 配置读取（共享契约）。
 *
 * 原 bridge-config（"bridge" 统一收口）已按 v1.1 改造拆分为四个相互独立的 provider 配置：
 * - LLM（chat / context-enricher / query-rewriter 共用的 OpenAI 兼容端点）
 * - Embedding（/v1/embeddings）
 * - Rerank（/v1/rerank 或 LLM-judge 回退）
 * - Judge（eval 的 LLM-as-judge 端点）
 *
 * 每个 provider 都有自己独立的 endpoint（baseUrl / apiKey / model）+ `enabled` 开关，
 * 互不干扰：缺某一组的 key 只禁用对应能力，不影响其它 provider（依赖倒置、各读各的 env）。
 * 生产维度约定：真实 embedding 默认 2048 维（nvidia/llama-nemotron-embed-vl-1b-v2），与 database 侧向量列迁移保持一致；
 * 调小需同步 migration，pgvector 列维度在创建时固定。
 */

/** 生产默认 embedding 维度，需与 packages/database 的向量列迁移一致。 */
export const DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS = 2048;

/**
 * 四个 provider 的环境变量名集中在此，避免各处硬编码产生命名漂移。
 * 各 provider 互不共享变量，新增 provider 只需在此追加一组。
 */
export const PROVIDER_ENV = {
  /** chat / 检索增强用的通用 LLM 端点（context-enricher、query-rewriter 也复用）。 */
  llm: {
    baseUrl: "AIAGENT_LLM_BASE_URL",
    apiKey: "AIAGENT_LLM_API_KEY",
    model: "AIAGENT_LLM_MODEL"
  },
  /** 真实 embedding 端点（/v1/embeddings）。 */
  embedding: {
    baseUrl: "AIAGENT_EMBEDDING_BASE_URL",
    apiKey: "AIAGENT_EMBEDDING_API_KEY",
    model: "AIAGENT_EMBEDDING_MODEL",
    dimensions: "AIAGENT_EMBEDDING_DIMENSIONS"
  },
  /** 真实 rerank 端点（/v1/rerank 或回退 LLM-judge）。 */
  rerank: {
    baseUrl: "AIAGENT_RERANK_BASE_URL",
    apiKey: "AIAGENT_RERANK_API_KEY",
    model: "AIAGENT_RERANK_MODEL"
  },
  /** eval 的 LLM-as-judge 端点。 */
  judge: {
    baseUrl: "AIAGENT_JUDGE_BASE_URL",
    apiKey: "AIAGENT_JUDGE_API_KEY",
    model: "AIAGENT_JUDGE_MODEL"
  }
} as const;

/** LLM provider 通用配置（chat / context-enricher / query-rewriter 共用）。 */
export interface LlmProviderConfig {
  /** OpenAI 兼容端点（含 /v1 前缀，base URL 不含具体路径）。 */
  baseUrl: string;
  /** 鉴权 Bearer token。 */
  apiKey: string;
  /** 模型名（如 hy3-x / deepseek-chat）。 */
  model: string;
  /** 是否具备真实调用条件（baseUrl、apiKey 与 model 同时非空）。 */
  enabled: boolean;
}

/** embedding provider 配置（/v1/embeddings）。 */
export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** embedding 模型名（如 text-embedding-3-small / bge-m3）。 */
  embeddingModel: string;
  /** 向量维度，需与向量库列维度一致；<=0 会被视为非法输入。 */
  dimensions: number;
  enabled: boolean;
}

/** rerank provider 配置（/v1/rerank 或回退 LLM-judge）。 */
export interface RerankProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** rerank / cross-encoder 模型名。 */
  rerankModel: string;
  enabled: boolean;
}

/** judge provider 配置（eval 的 LLM-as-judge）。 */
export interface JudgeProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

/**
 * 读取 LLM provider 通用配置（chat / context-enricher / query-rewriter 共用）。
 *
 * @returns baseUrl、apiKey、model 与 enabled 标记；任一必需字段缺失时 enabled 为 false。
 */
export function readLlmProviderConfig(): LlmProviderConfig {
  const baseUrl = process.env[PROVIDER_ENV.llm.baseUrl]?.trim() ?? "";
  const apiKey = process.env[PROVIDER_ENV.llm.apiKey]?.trim() ?? "";
  const model = process.env[PROVIDER_ENV.llm.model]?.trim() ?? "";
  return {
    baseUrl,
    apiKey,
    model,
    enabled: baseUrl.length > 0 && apiKey.length > 0 && model.length > 0
  };
}

/**
 * 读取 embedding provider 配置。
 *
 * embedding 模型无跨 provider 默认值；维度默认 2048，可由环境变量覆盖。
 * 维度解析失败或非正整数时回退 2048（与 database 向量列维度契约保持一致）。
 * baseUrl、apiKey、embeddingModel 均非空时才启用，避免把 chat 模型误发到 `/embeddings`。
 *
 * @returns embedding 端点配置与启用标记。
 */
export function readEmbeddingProviderConfig(): EmbeddingProviderConfig {
  const baseUrl = process.env[PROVIDER_ENV.embedding.baseUrl]?.trim() ?? "";
  const apiKey = process.env[PROVIDER_ENV.embedding.apiKey]?.trim() ?? "";
  const embeddingModel = process.env[PROVIDER_ENV.embedding.model]?.trim() ?? "";
  const dimensionsRaw = process.env[PROVIDER_ENV.embedding.dimensions]?.trim();
  const parsed = dimensionsRaw ? Number.parseInt(dimensionsRaw, 10) : NaN;
  const dimensions = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS;
  return {
    baseUrl,
    apiKey,
    embeddingModel,
    dimensions,
    enabled: baseUrl.length > 0 && apiKey.length > 0 && embeddingModel.length > 0
  };
}

/**
 * 读取 rerank provider 配置。
 *
 * @returns rerank 端点配置与启用标记；模型只读取独立的 rerank provider 配置。
 */
export function readRerankProviderConfig(): RerankProviderConfig {
  const baseUrl = process.env[PROVIDER_ENV.rerank.baseUrl]?.trim() ?? "";
  const apiKey = process.env[PROVIDER_ENV.rerank.apiKey]?.trim() ?? "";
  const rerankModel = process.env[PROVIDER_ENV.rerank.model]?.trim() ?? "";
  return {
    baseUrl,
    apiKey,
    rerankModel,
    enabled: baseUrl.length > 0 && apiKey.length > 0 && rerankModel.length > 0
  };
}

/**
 * 读取 judge provider 配置（eval 的 LLM-as-judge）。
 *
 * Judge 调用 `/chat/completions`，请求体必须携带明确 model；因此 model 也属于启用条件，
 * 缺失时直接 disabled，比发起必然失败的网络请求更可诊断。
 *
 * @returns judge 端点配置与启用标记；模型只读取独立的 judge provider 配置。
 */
export function readJudgeProviderConfig(): JudgeProviderConfig {
  const baseUrl = process.env[PROVIDER_ENV.judge.baseUrl]?.trim() ?? "";
  const apiKey = process.env[PROVIDER_ENV.judge.apiKey]?.trim() ?? "";
  const model = process.env[PROVIDER_ENV.judge.model]?.trim() ?? "";
  return {
    baseUrl,
    apiKey,
    model,
    enabled: baseUrl.length > 0 && apiKey.length > 0 && model.length > 0
  };
}
