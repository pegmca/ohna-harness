/**
 * 记忆存储工厂：统一创建 InMemory / Jsonl / Pg 三种实现。
 * 长期记忆外置（PG + pgvector）只需新增 "pg" 分支并复用 MemoryStore 接口，调用方零改动。
 */
import { InMemoryMemoryStore } from "./in-memory-store.js";
import { JsonlMemoryStore } from "./jsonl-store.js";
import type { QueryExecutor } from "./pg-vector-store.js";
import { PgVectorMemoryStore } from "./pg-vector-store.js";
import type { MemoryStore } from "./types.js";

/** 创建记忆存储的选项。 */
export interface CreateMemoryStoreOptions {
  /** jsonl 模式必填：episode 持久化文件路径。 */
  filePath?: string;
  /** jsonl 模式可选：工作记忆持久化文件路径。 */
  workingFilePath?: string;
  /** pg 模式必填：注入的查询执行器（真实 pg.Pool 适配而来，避免运行时依赖 pg）。 */
  query?: QueryExecutor;
  /** pg 模式可选：归属用户；NULL 表示共享记忆（学习原型未做多租户）。 */
  ownerUserId?: string | null;
  /** pg 模式可选：向量维度，缺省 32（必须匹配 memory_episodes.embedding 列维度）。 */
  dimensions?: number;
  /** pg 模式可选：绑定 embedding 模型名；缺省为本地确定性占位。 */
  embeddingModel?: string;
  /** pg 模式可选：自定义 embedder；缺省使用本地确定性 embedder。 */
  embed?: (text: string) => number[];
}

/**
 * 按 kind 创建记忆存储实例。
 *
 * @param kind "memory"（纯内存）/ "jsonl"（Node fs 持久化）/ "pg"（PG + pgvector 外置）。
 * @param options jsonl 模式需要 filePath；pg 模式需要 query（注入执行器）。
 * @returns 记忆存储实例（实现 MemoryStore）。
 */
export function createMemoryStore(
  kind: "memory" | "jsonl" | "pg",
  options: CreateMemoryStoreOptions = {},
): MemoryStore {
  if (kind === "jsonl") {
    if (!options.filePath) {
      throw new Error("createMemoryStore: jsonl 模式需要提供 filePath");
    }
    return new JsonlMemoryStore({ filePath: options.filePath, workingFilePath: options.workingFilePath });
  }
  if (kind === "pg") {
    if (!options.query) {
      throw new Error("createMemoryStore: pg 模式需要提供 query（注入的 QueryExecutor）");
    }
    return new PgVectorMemoryStore({
      query: options.query,
      ownerUserId: options.ownerUserId ?? null,
      dimensions: options.dimensions,
      embeddingModel: options.embeddingModel,
      embed: options.embed,
    });
  }
  return new InMemoryMemoryStore();
}
