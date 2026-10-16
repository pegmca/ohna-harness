/**
 * 外置长期记忆（PG + pgvector）实现：把情节记忆从「进程内」提升到「跨实例共享」。
 *
 * 设计原则（对照 AGENTS.md 包边界）：
 * - 本文件**不 import `@aiagent/database` / `@aiagent/rag` / `pg`** 等运行时依赖，避免
 *   `@aiagent/memory` 反向依赖数据库包；真正的数据源（pg.Pool）以「注入的 `QueryExecutor`
 *   接口」传入，composition root（apps/api）负责把真实 pool 适配成该接口。
 * - 维度固定 32，与 `@aiagent/database` 的 `POSTGRES_RAG_VECTOR_DIMENSIONS` 常量对齐；
 *   这里只复用「数字 32」这一约定，不引用该包（无依赖）。
 * - 向量检索用确定性本地 embedder（hashing trick），零依赖、纯函数；它是 RAG 侧
 *   `deterministic-mock` 32 维向量在记忆层的对应物，待真实 embedding 客户端落地后再替换。
 *
 * 语义边界：
 * - **长期情节记忆（episodic）落 PG**，跨会话、跨实例共享——这是生产级分水岭。
 * - **工作记忆（WorkingMemory）保持进程内**：它是短期、在上下文窗口内的状态，不需要外置；
 *   外置反而引入无谓的 IO 与一致性复杂度，故沿用 InMemory 同语义实现。
 * - **多租户本切片不做**：`owner_user_id` 列允许 NULL（学习原型共享记忆），但所有查询都用
 *   `owner_user_id IS NOT DISTINCT FROM $owner` 作为 WHERE 条件，未来按 owner 过滤零改动。
 *
 * 失败处理：pg 异常一律吞掉，不把 SQL / 连接信息泄漏给上层；`retrieve` / `listEpisodes`
 * 优雅降级返回空数组，保证 agent loop 不被记忆层故障拖垮。
 */

import { tokenize } from "./similarity.js";
import type {
  EpisodeMemory,
  MemoryStore,
  RetrievedMemory,
  WorkingMemory,
  WorkingMemoryFact,
} from "./types.js";

/** 向量列固定维度；与 database 包 POSTGRES_RAG_VECTOR_DIMENSIONS 对齐（仅常量一致，无依赖）。 */
export const MEMORY_VECTOR_DIMENSIONS = 32;

/**
 * 最小查询执行器：把真实 pg.Pool / PoolClient 适配成本接口即可注入，避免运行时依赖 pg。
 * 只需一个 `query` 方法，返回 `{ rows }`，与 node-postgres 的返回值形状兼容。
 */
export interface QueryExecutor {
  /** 执行参数化 SQL；参数通过占位符传入，绝不拼接用户输入。 */
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 文本 → 向量 的 embedder 类型。 */
export type Embedder = (text: string) => number[];

/** 确定性 embedder 工厂类型签名：返回可调用的 embedder。 */
export type DeterministicEmbedder = (dimensions?: number) => Embedder;

/**
 * 字符串 → 32 位有符号整数哈希（djb2 变体）。纯函数、零依赖，仅用于把 token 映射到固定桶位。
 *
 * @param value 输入 token。
 * @returns 32 位有符号整数。
 */
function hashToken(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/**
 * 创建确定性 embedder（hashing trick，对齐 RAG deterministic-mock 的 32 维）。
 *
 * 为什么是「本地确定性」而非真实语义嵌入：
 * - 学习原型不引入 embedding 模型 / 向量服务依赖；确定性哈希使得同一文本永远得到同一向量，
 *   便于测试与复现，且向量可直接写进 pgvector `halfvec(32)` 列。
 * - 算法类似 sklearn `HashingVectorizer`（带符号）：对每个 token 取 `hash mod dimensions`
 *   作为桶位，按词频累加、符号由 hash 最低位决定（正负抵消降低碰撞偏差），最后 L2 归一化为单位向量。
 * - 局限：纯词面、无语义（"营收"/"收入"不相关）；这是占位实现，真实语义检索需替换 embed。
 *
 * @param dimensions 向量维度，缺省 32（与 database 列一致）。
 * @returns 文本 → 单位向量 的纯函数 embedder。
 */
export const createDeterministicEmbedder: DeterministicEmbedder = (dimensions = MEMORY_VECTOR_DIMENSIONS) => {
  return (text: string): number[] => {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const vector = new Array<number>(dimensions).fill(0);
    for (const [token, count] of counts) {
      const hash = hashToken(token);
      const bucket = Math.abs(hash) % dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[bucket] += sign * count;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((value) => value / norm);
  };
};

/** PgVectorMemoryStore 构造选项。 */
export interface PgVectorMemoryStoreOptions {
  /** 注入的查询执行器（真实 pg.Pool 适配而来）；不可缺省。 */
  query: QueryExecutor;
  /** 归属用户；NULL 表示共享记忆（学习原型未做多租户）。 */
  ownerUserId?: string | null;
  /** 向量维度，缺省 32（必须匹配 memory_episodes.embedding 列维度）。 */
  dimensions?: number;
  /** 绑定 embedding 模型名（便于未来按模型隔离，当前为本地确定性占位）。 */
  embeddingModel?: string;
  /** 自定义 embedder；缺省使用本地确定性 embedder。 */
  embed?: Embedder;
}

/** 初始空工作记忆。 */
function emptyWorkingMemory(): WorkingMemory {
  return { summary: "", facts: [], updatedAt: 0 };
}

/**
 * 把任意形态的时间戳转为 Unix 毫秒，供 EpisodeMemory.timestamp 使用。
 *
 * @param value Date / ISO 字符串 / 毫秒数字。
 * @returns 毫秒时间戳；无法解析时返回 0。
 */
function toEpochMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 外置长期记忆存储：episode 落 PG/pgvector，工作记忆保持进程内。
 * 实现 `MemoryStore` 接口，调用方零改动；仅通过工厂 `createMemoryStore({ kind: "pg" })` 选择。
 */
export class PgVectorMemoryStore implements MemoryStore {
  private readonly executor: QueryExecutor;
  private readonly ownerUserId: string | null;
  private readonly dimensions: number;
  private readonly embedder: Embedder;
  private readonly working: WorkingMemory = emptyWorkingMemory();

  /**
   * @param options 注入的 query / owner / 维度 / embedder。
   */
  public constructor(options: PgVectorMemoryStoreOptions) {
    this.executor = options.query;
    this.ownerUserId = options.ownerUserId ?? null;
    this.dimensions = options.dimensions ?? MEMORY_VECTOR_DIMENSIONS;
    this.embedder = options.embed ?? createDeterministicEmbedder(this.dimensions);
  }

  /**
   * 把数值向量格式化为 pgvector 文本输入 `[a,b,...]`。
   * 仅在本实例内部使用，绝不拼接用户输入——向量由本地 embedder 计算得到，非外部输入。
   *
   * @param vector 数值向量。
   * @returns pgvector 字面量字符串。
   */
  private vectorLiteral(vector: number[]): string {
    return `[${vector.join(",")}]`;
  }

  /** @inheritdoc 幂等写入（ON CONFLICT 复用 id 覆盖），失败仅吞掉、不泄漏 SQL。 */
  async saveEpisode(episode: EpisodeMemory): Promise<void> {
    const embedding = this.embedder(episode.content);
    const sql = `
      insert into memory_episodes (
        id, owner_user_id, type, content, embedding, source_turn, metadata, created_at
      ) values ($1, $2, $3, $4, $5::public.halfvec, $6, $7, now())
      on conflict (id) do update set
        owner_user_id = excluded.owner_user_id,
        type = excluded.type,
        content = excluded.content,
        embedding = excluded.embedding,
        source_turn = excluded.source_turn,
        metadata = excluded.metadata
    `;
    const params = [
      episode.id,
      this.ownerUserId,
      episode.type,
      episode.content,
      this.vectorLiteral(embedding),
      episode.sourceTurn ?? null,
      episode.metadata ?? null,
    ];
    try {
      await this.executor.query(sql, params);
    } catch {
      // 记忆写回是 fire-and-forget 副作用（hooks 不 await、不 catch），吞掉异常避免未捕获拒绝。
    }
  }

  /** @inheritdoc 向量余弦最近邻检索；失败优雅降级返回空数组。 */
  async retrieve(query: string, k = 5): Promise<RetrievedMemory[]> {
    const embedding = this.vectorLiteral(this.embedder(query));
    const sql = `
      select id, content, type, metadata,
             1 - (embedding OPERATOR(public.<=>) $2::public.halfvec) as score
        from memory_episodes
       where owner_user_id is not distinct from $1
       order by embedding OPERATOR(public.<=>) $2::public.halfvec
       limit $3
    `;
    try {
      const result = await this.executor.query(sql, [this.ownerUserId, embedding, k]);
      return result.rows.map((row) => ({
        record: {
          id: String(row.id),
          timestamp: 0,
          content: String(row.content),
          type: row.type as EpisodeMemory["type"],
          metadata: (row.metadata as Record<string, unknown>) ?? undefined,
        },
        score: typeof row.score === "number" ? row.score : Number(row.score),
      }));
    } catch {
      return [];
    }
  }

  /** @inheritdoc 进程内工作记忆，返回防御性副本。 */
  getWorkingMemory(): WorkingMemory {
    return { ...this.working, facts: [...this.working.facts] };
  }

  /** @inheritdoc 进程内更新：summary 覆盖、facts 按 key 合并。 */
  updateWorkingMemory(patch: Partial<Omit<WorkingMemory, "updatedAt">>): void {
    if (typeof patch.summary === "string") {
      this.working.summary = patch.summary;
    }
    if (Array.isArray(patch.facts)) {
      const byKey = new Map<string, WorkingMemoryFact>(this.working.facts.map((fact) => [fact.key, fact]));
      for (const fact of patch.facts) {
        byKey.set(fact.key, fact);
      }
      this.working.facts = [...byKey.values()];
    }
    this.working.updatedAt = Date.now();
  }

  /** @inheritdoc 列出全部情节记忆（含 owner 过滤）；失败优雅降级返回空数组。 */
  async listEpisodes(): Promise<EpisodeMemory[]> {
    const sql = `
      select id, type, content, source_turn, metadata, created_at
        from memory_episodes
       where owner_user_id is not distinct from $1
       order by created_at desc
    `;
    try {
      const result = await this.executor.query(sql, [this.ownerUserId]);
      return result.rows.map((row) => ({
        id: String(row.id),
        timestamp: toEpochMillis(row.created_at),
        content: String(row.content),
        type: row.type as EpisodeMemory["type"],
        sourceTurn: typeof row.source_turn === "number" ? row.source_turn : (row.source_turn as number | undefined),
        metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      }));
    } catch {
      return [];
    }
  }
}
