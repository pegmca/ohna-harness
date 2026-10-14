import type pg from "pg";
import type { VectorStore } from "@aiagent/rag";
import { createInMemoryVectorStoreFactory } from "@aiagent/rag";
import { createPostgresVectorStore, POSTGRES_RAG_VECTOR_MODEL, PRODUCTION_EMBEDDING_DIMENSIONS } from "./rag-vector-store.js";

/** env 工厂缺省生产维度；与 P1 真实模型约定一致。 */
export const DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS = PRODUCTION_EMBEDDING_DIMENSIONS;

/** env 驱动工厂的可选生产默认；由 composition root 从真实 embedding client 透传。 */
export interface VectorStoreEnvOptions {
  /**
   * 生产 embedding 模型名；缺省或空串回退到 deterministic mock 模型（legacy/test fixture 默认）。
   * 组合根在 embedding provider 关闭时会读到空串，这里显式把空串视作"未配置"再兜底，
   * 避免 pgvector 侧把 model 记成 `""` 这类不可诊断的值。
   */
  embeddingModel?: string;
  /** 生产 embedding 维度；缺省回退到 2048（DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS）。 */
  dimensions?: number;
}

/**
 * 按环境变量选择 VectorStore 实现，作为 composition root 的注入边界。
 *
 * 存在 DATABASE_URL → 生产走 PostgreSQL pgvector，维度白名单为解析后的固定列表（如 [2048]，列维度固定），
 * 模型白名单为 "any" 以接受真实 2048 维生产 embedding；无 DATABASE_URL → 退化为内存 VectorStore fixture，
 * 仅供单测/eval/本地 demo 使用，无持久化。内存实现来自 @aiagent/rag，database 仅消费其类型与 factory。
 *
 * @param pool PostgreSQL 连接池（仅在启用 pgvector 时使用）。
 * @param options 可选生产默认模型名与维度。
 * @returns 按 owner 复用的 VectorStore factory。
 */
export function createVectorStoreFromEnv(
  pool: pg.Pool,
  options: VectorStoreEnvOptions = {}
): (ownerUserId: string | null) => VectorStore {
  if (process.env.DATABASE_URL) {
    // 空串（provider 关闭时组合根传来的值）按"未配置"处理：`??` 只兜 undefined，兜不住 ""。
    const embeddingModel = normalizeEmbeddingModel(options.embeddingModel);
    const dimensions = options.dimensions ?? DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS;
    return (ownerUserId) =>
      createPostgresVectorStore(pool, {
        ownerUserId,
        embeddingModel,
        dimensions,
        // 传入解析后的维度白名单（如 [2048]）而非 "any"：pgvector 列维度固定，
        // 早期结构化错误比静默放行后再在 SQL 层失败更可诊断（allowedDimensions 现已生效）。
        allowedDimensions: [dimensions],
        allowedModels: "any"
      });
  }
  return createInMemoryVectorStoreFactory();
}

/**
 * 归一化 embedding 模型名：空串或纯空白按"未配置"处理，回退到 fixture 默认模型。
 *
 * @param embeddingModel 组合根透传的模型名，未配置时可能是空串。
 * @returns 非空模型名。
 */
function normalizeEmbeddingModel(embeddingModel: string | undefined): string {
  const trimmed = embeddingModel?.trim();
  return trimmed ? trimmed : POSTGRES_RAG_VECTOR_MODEL;
}
