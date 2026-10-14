import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  EmbeddedChunk,
  EmbeddingVector,
  RagStructuredError,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreResult
} from "@aiagent/rag";
import { DEFAULT_MOCK_EMBEDDING_MODEL } from "@aiagent/rag";

/** PR-07 的固定向量列维度；真实模型不得混入此索引。 */
export const POSTGRES_RAG_VECTOR_DIMENSIONS = 32;
/**
 * 未显式传模型时的 legacy/test fixture 默认值；生产 composition root 必须透传真实 provider 模型。
 * 保留既有导出名以维持公共 API，不能把它理解为 PostgreSQL 生产模型。
 */
export const POSTGRES_RAG_VECTOR_MODEL = DEFAULT_MOCK_EMBEDDING_MODEL;
/** 当前工程闭环的 provider 标识。 */
export const POSTGRES_RAG_VECTOR_PROVIDER = "deterministic-mock";
/**
 * 生产 embedding 默认维度；与 P1 真实模型（如 OpenAI text-embedding-3-small 1536 维）约定一致。
 * 该值仅用于 env 工厂在没有显式配置时的兜底，adapter 实际写入维度由调用方通过 options.dimensions 决定。
 */
export const PRODUCTION_EMBEDDING_DIMENSIONS = 1536;

/** PostgreSQL VectorStore 的隔离配置。 */
export interface PostgresVectorStoreOptions {
  ownerUserId: string | null;
  embeddingProvider?: string;
  /** 写入向量库时绑定的维度；缺省回退到 32 维固定值以保持既有 fixture 向后兼容。 */
  dimensions?: number;
  /** 写入向量库时绑定的模型名；缺省回退到 deterministic mock 模型以保持向后兼容。 */
  embeddingModel?: string;
  /**
   * 允许的维度白名单，同时约束 chunk 校验（validateChunks）与索引配置（validateConfiguration）。
   * - "any"：不限制维度（仅要求非空有限向量）。
   * - number[]：仅允许列表内的维度。
   * - undefined（缺省）：保持向后兼容，仅接受 POSTGRES_RAG_VECTOR_DIMENSIONS（32 维）。
   */
  allowedDimensions?: number[] | "any";
  /**
   * 允许的模型白名单；"any" 表示不限制模型，string[] 表示仅允许列表内模型。
   * 缺省（undefined）保持向后兼容：仅接受 POSTGRES_RAG_VECTOR_MODEL（deterministic mock）。
   */
  allowedModels?: string[] | "any";
}

/**
 * 创建 PostgreSQL pgvector adapter。
 *
 * owner 身份在构造时绑定，调用方不能在单次 search 中覆盖；SQL 在 cosine 排序前连接
 * document lineage 并执行 scope、状态、模型和维度过滤。所有 pg 异常均映射为安全的
 * RAG 结构化错误，不把 SQL、连接信息或原始 driver message 返回给上层。
 *
 * @param pool PostgreSQL 连接池。
 * @param options owner、provider 与固定维度配置；模型固定复用 RAG 默认常量。
 * @returns 实现现有 VectorStore 端口的 pgvector adapter。
 */
export function createPostgresVectorStore(pool: pg.Pool, options: PostgresVectorStoreOptions): VectorStore {
  return new PostgresVectorStore(pool, {
    ownerUserId: options.ownerUserId,
    embeddingModel: options.embeddingModel ?? POSTGRES_RAG_VECTOR_MODEL,
    embeddingProvider: options.embeddingProvider ?? POSTGRES_RAG_VECTOR_PROVIDER,
    dimensions: options.dimensions ?? POSTGRES_RAG_VECTOR_DIMENSIONS,
    allowedDimensions: options.allowedDimensions,
    allowedModels: options.allowedModels
  });
}

interface NormalizedOptions {
  ownerUserId: string | null;
  embeddingModel: string;
  embeddingProvider: string;
  dimensions: number;
  allowedDimensions?: number[] | "any";
  allowedModels?: string[] | "any";
}

interface ResolvedChunkRow {
  id: string;
  content_checksum: string;
}

interface ExistingEmbeddingRow {
  chunk_id: string;
  chunk_content_checksum: string;
}

interface VectorMatchRow {
  chunk_id: string;
  document_id: string;
  source_uri: string;
  chunk_index: number;
  chunk_text: string;
  heading: string | null;
  page_number: number | null;
  metadata: Record<string, string | number | boolean | null>;
  chunker_version: string;
  embedding: string;
  embedding_model: string;
  score: number | string;
}

/** pgvector adapter 的具体实现。 */
class PostgresVectorStore implements VectorStore {
  /**
   * @param pool PostgreSQL 连接池。
   * @param options 已规范化且绑定 owner 的配置。
   */
  public constructor(
    private readonly pool: pg.Pool,
    private readonly options: NormalizedOptions
  ) {}

  /**
   * 幂等写入 chunk embeddings。
   *
   * 写前同时校验 32 维、模型、有限数值以及正文 SHA-256；当同一 chunk/model/dimensions
   * 的 checksum 变化时显式刷新向量与 created_at，绝不把旧向量当作幂等结果复用。
   *
   * @param chunks 已生成 embedding 的 chunks。
   * @returns 写入、替换和当前模型索引规模；失败返回安全结构化错误。
   */
  public async upsertChunks(chunks: readonly EmbeddedChunk[]): Promise<VectorStoreResult> {
    const validationError = this.validateConfiguration() ?? this.validateChunks(chunks);
    if (validationError) return { ok: false, error: validationError };
    if (chunks.length === 0) {
      try {
        return {
          ok: true,
          upsertedCount: 0,
          replacedCount: 0,
          totalCount: await this.countEmbeddings(),
          dimensions: this.options.dimensions
        };
      } catch {
        return databaseFailure();
      }
    }

    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("begin");
      let replacedCount = 0;
      for (const chunk of chunks) {
        const resolved = await this.resolveAuthorizedChunk(client, chunk);
        if (!resolved.ok) {
          await client.query("rollback");
          return resolved;
        }
        const checksum = checksumText(chunk.text);
        if (checksum !== resolved.row.content_checksum) {
          await client.query("rollback");
          return failure("embedding_checksum_mismatch", "chunk 正文校验和与持久化 lineage 不一致。", {
            chunkId: chunk.chunkId
          });
        }
        const existing = await client.query<ExistingEmbeddingRow>(
          `select chunk_id, chunk_content_checksum
             from chunk_embeddings
            where chunk_id = $1 and embedding_model = $2 and dimensions = $3
            for update`,
          [resolved.row.id, this.options.embeddingModel, this.options.dimensions]
        );
        if (existing.rows[0] && existing.rows[0].chunk_content_checksum !== checksum) replacedCount += 1;
        await client.query(
          `insert into chunk_embeddings(
             id, chunk_id, embedding_provider, embedding_model, dimensions, embedding,
             chunk_content_checksum, created_at
           ) values ($1, $2, $3, $4, $5, $6::public.vector, $7, now())
           on conflict (chunk_id, embedding_model, dimensions) do update
             set embedding_provider = excluded.embedding_provider,
                 embedding = excluded.embedding,
                 chunk_content_checksum = excluded.chunk_content_checksum,
                 created_at = excluded.created_at
           where chunk_embeddings.chunk_content_checksum is distinct from excluded.chunk_content_checksum`,
          [
            randomUUID(),
            resolved.row.id,
            this.options.embeddingProvider,
            this.options.embeddingModel,
            this.options.dimensions,
            vectorLiteral(chunk.embedding),
            checksum
          ]
        );
      }
      const totalCount = await this.countEmbeddings(client);
      await client.query("commit");
      return { ok: true, upsertedCount: chunks.length, replacedCount, totalCount, dimensions: this.options.dimensions };
    } catch {
      await client?.query("rollback").catch(() => undefined);
      return databaseFailure();
    } finally {
      client?.release();
    }
  }

  /**
   * 在授权和有效版本候选集上执行 cosine topK。
   *
   * @param queryVector 查询向量。
   * @param options 保持现有 topK、documentId、source 过滤语义。
   * @returns 稳定排序的完整 EmbeddedChunk matches。
   */
  public async search(queryVector: EmbeddingVector, options: VectorSearchOptions = {}): Promise<VectorSearchResult> {
    const validationError = this.validateConfiguration() ?? validateQuery(queryVector, options, this.options.dimensions);
    if (validationError) return { ok: false, error: validationError };
    const topK = Math.min(options.topK ?? 5, 50);
    const params: unknown[] = [
      this.options.ownerUserId,
      this.options.embeddingModel,
      this.options.dimensions,
      vectorLiteral(queryVector)
    ];
    const filters: string[] = [];
    if (options.filter?.documentId !== undefined) {
      params.push(options.filter.documentId);
      filters.push(`and d.id = $${params.length}::uuid`);
    }
    if (options.filter?.documentIds !== undefined) {
      params.push(options.filter.documentIds);
      filters.push(`and d.id = any($${params.length}::uuid[])`);
    }
    if (options.filter?.source !== undefined) {
      params.push(options.filter.source);
      filters.push(`and v.source_uri = $${params.length}`);
    }
    params.push(topK);

    try {
      // MATERIALIZED 是安全边界：禁止 planner 把近邻排序提前到 owner/scope 过滤之前。
      const result = await this.pool.query<VectorMatchRow>(
        `with authorized_candidates as materialized (
           select
             e.id as embedding_id,
             v.id::text || '_' || c.chunker_version || '_chunk_' || lpad(c.chunk_index::text, 4, '0') as chunk_id,
             d.id as document_id, v.source_uri, c.chunk_index, c.chunk_text, c.heading, c.page_number,
             c.metadata, c.chunker_version, e.embedding, e.embedding_model
           from chunk_embeddings e
           join chunks c on c.id = e.chunk_id
           join document_versions v on v.id = c.document_version_id
           join documents d on d.id = v.document_id
           where d.deleted_at is null
             and v.status = 'indexed'
             and (d.scope in ('shared', 'demo') or (d.scope = 'private' and d.owner_user_id = $1::uuid))
             and e.embedding_model = $2
             and e.dimensions = $3
             ${filters.join("\n             ")}
         )
         select chunk_id, document_id, source_uri, chunk_index, chunk_text, heading, page_number,
                metadata, chunker_version, embedding::text, embedding_model,
                1 - (embedding OPERATOR(public.<=>) $4::public.vector) as score
           from authorized_candidates
          order by embedding OPERATOR(public.<=>) $4::public.vector, embedding_id
         limit $${params.length}`,
        params
      );
      return {
        ok: true,
        matches: result.rows.map((row, index) => ({
          chunk: mapMatch(row),
          score: Number(row.score),
          rank: index + 1
        }))
      };
    } catch {
      return databaseFailure();
    }
  }

  /**
   * @returns adapter 固定配置错误；合法时返回 undefined。
   */
  private validateConfiguration(): RagStructuredError | undefined {
    // 结构校验：维度必须是正整数，拒绝 0/负数/小数。
    if (!Number.isInteger(this.options.dimensions) || this.options.dimensions <= 0) {
      return {
        code: "vector_store_dimension_mismatch",
        message: "embedding 维度必须是大于 0 的整数。",
        details: { actualDimensions: this.options.dimensions }
      };
    }
    // 维度白名单：allowedDimensions==="any" 放行；数组则必须命中；缺省保持 32 维向后兼容。
    if (this.options.allowedDimensions === "any") {
      // 不限制维度。
    } else if (Array.isArray(this.options.allowedDimensions)) {
      if (!this.options.allowedDimensions.includes(this.options.dimensions)) {
        return {
          code: "vector_store_dimension_mismatch",
          message: "当前 PostgreSQL 向量索引未将当前维度列入允许集合。",
          details: { allowedDimensions: this.options.allowedDimensions, actualDimensions: this.options.dimensions }
        };
      }
    } else if (this.options.dimensions !== POSTGRES_RAG_VECTOR_DIMENSIONS) {
      return {
        code: "vector_store_dimension_mismatch",
        message: "当前 PostgreSQL 向量索引仅支持 32 维 embedding（向后兼容路径）。",
        details: { expectedDimensions: POSTGRES_RAG_VECTOR_DIMENSIONS, actualDimensions: this.options.dimensions }
      };
    }
    if (!this.options.embeddingModel.trim()) {
      return { code: "embedding_model_mismatch", message: "embedding model 不能为空。" };
    }
    // 模型白名单：allowedModels==="any" 放行；数组则必须命中；缺省保持 deterministic mock 向后兼容。
    if (this.options.allowedModels === "any") {
      // 不限制模型。
    } else if (Array.isArray(this.options.allowedModels)) {
      if (!this.options.allowedModels.includes(this.options.embeddingModel)) {
        return {
          code: "embedding_model_mismatch",
          message: "当前 PostgreSQL 向量索引未将当前模型列入允许集合。",
          details: { allowedModels: this.options.allowedModels, actualModel: this.options.embeddingModel }
        };
      }
    } else if (this.options.embeddingModel !== POSTGRES_RAG_VECTOR_MODEL) {
      return {
        code: "embedding_model_mismatch",
        message: "当前 PostgreSQL 向量索引仅支持固定 deterministic mock 模型（向后兼容路径）。"
      };
    }
    return undefined;
  }

  /**
   * @param chunks 待校验 chunks。
   * @returns 首个安全结构化错误。
   */
  private validateChunks(chunks: readonly EmbeddedChunk[]): RagStructuredError | undefined {
    // 维度校验尊重 allowedDimensions 语义：数组白名单命中、单维度相等、"any" 仅要求非空。
    const invalid = chunks.find((chunk) =>
      !this.isDimensionAllowed(chunk.embedding.length) ||
      chunk.embedding.some((value) => !Number.isFinite(value)) ||
      !this.isModelAllowed(chunk.embeddingModel)
    );
    if (!invalid) return undefined;
    if (!this.isDimensionAllowed(invalid.embedding.length)) {
      const expected = this.dimensionExpectation();
      return {
        code: "embedding_dimension_mismatch",
        message: `chunk embedding 维度(${invalid.embedding.length}) 与向量库期望(${expected}) 不一致；pgvector 列维度固定为 ${expected}，请使用真实 ${expected} 维 embedding（配置 provider 环境变量 AIAGENT_EMBEDDING_* 与 AIAGENT_EMBEDDING_DIMENSIONS=${expected}）或去掉 DATABASE_URL 以使用内存 store。`,
        details: { expectedDimensions: expected, actualDimensions: invalid.embedding.length, chunkId: invalid.chunkId }
      };
    }
    if (invalid.embedding.some((value) => !Number.isFinite(value))) {
      return {
        code: "embedding_dimension_mismatch",
        message: "chunk embedding 必须仅包含有限数值。",
        details: { actualDimensions: invalid.embedding.length, chunkId: invalid.chunkId }
      };
    }
    return {
      code: "embedding_model_mismatch",
      message: "chunk embedding model 不在向量库允许模型集合内。",
      details: { allowedModels: this.options.allowedModels ?? [POSTGRES_RAG_VECTOR_MODEL], actualModel: invalid.embeddingModel, chunkId: invalid.chunkId }
    };
  }

  /**
   * 判断 chunk 向量维度是否被允许；尊重 allowedDimensions 语义，避免 "any" 沦为 no-op。
   *
   * @param length chunk embedding 向量长度（维度）。
   * @returns true 表示允许写入向量库。
   */
  private isDimensionAllowed(length: number): boolean {
    const allowed = this.options.allowedDimensions;
    if (allowed === "any") return length > 0;
    if (Array.isArray(allowed)) return allowed.includes(length);
    return length === this.options.dimensions;
  }

  /**
   * 计算向量库期望维度的可读描述，用于结构化错误消息。
   *
   * "any" → "任意维度"；数组 → 以 / 连接的允许维度；缺省 → 单固定维度。
   *
   * @returns 期望维度描述（数字或字符串）。
   */
  private dimensionExpectation(): number | string {
    const allowed = this.options.allowedDimensions;
    if (allowed === "any") return "任意维度";
    if (Array.isArray(allowed)) return allowed.length === 1 ? allowed[0] : allowed.join("/");
    return this.options.dimensions;
  }

  /**
   * @param model chunk 携带的 embedding 模型名。
   * @returns 模型是否在允许集合内（缺省仅 deterministic mock）。
   */
  private isModelAllowed(model: string): boolean {
    if (this.options.allowedModels === "any") return true;
    if (Array.isArray(this.options.allowedModels)) return this.options.allowedModels.includes(model);
    return model === POSTGRES_RAG_VECTOR_MODEL;
  }

  /**
   * @param client 当前事务连接。
   * @param chunk 调用方 chunk。
   * @returns 授权且 lineage 一致的数据库 chunk。
   */
  private async resolveAuthorizedChunk(
    client: pg.PoolClient,
    chunk: EmbeddedChunk
  ): Promise<{ ok: true; row: ResolvedChunkRow } | { ok: false; error: RagStructuredError }> {
    const result = await client.query<ResolvedChunkRow>(
      `select c.id, c.content_checksum
         from chunks c
         join document_versions v on v.id = c.document_version_id
         join documents d on d.id = v.document_id
        where v.id::text || '_' || c.chunker_version || '_chunk_' || lpad(c.chunk_index::text, 4, '0') = $1
          and d.id = $2::uuid
          and v.source_uri = $3
          and v.status = 'indexed'
          and d.deleted_at is null
          and (d.scope in ('shared', 'demo') or (d.scope = 'private' and d.owner_user_id = $4::uuid))`,
      [chunk.chunkId, chunk.documentId, chunk.source, this.options.ownerUserId]
    );
    const row = result.rows[0];
    return row
      ? { ok: true, row }
      : failure("retrieval_failed", "chunk 不存在、状态不可索引或当前用户无权写入。", { chunkId: chunk.chunkId });
  }

  /**
   * @param client 可选事务连接。
   * @returns 当前模型/维度的 embedding 总数。
   */
  private async countEmbeddings(client: pg.Pool | pg.PoolClient = this.pool): Promise<number> {
    const result = await client.query<{ count: number }>(
      "select count(*)::integer as count from chunk_embeddings where embedding_model = $1 and dimensions = $2",
      [this.options.embeddingModel, this.options.dimensions]
    );
    return result.rows[0]?.count ?? 0;
  }
}

/**
 * @param queryVector 查询向量。
 * @param options 检索参数。
 * @param dimensions 向量库绑定维度，用于校验 query 维度一致性。
 * @returns 参数错误或 undefined。
 */
function validateQuery(queryVector: EmbeddingVector, options: VectorSearchOptions, dimensions: number): RagStructuredError | undefined {
  if (queryVector.length !== dimensions || queryVector.some((value) => !Number.isFinite(value))) {
    return {
      code: "vector_store_dimension_mismatch",
      message: "query vector 必须是与向量库维度一致的有限数值向量。",
      details: { expectedDimensions: dimensions, actualDimensions: queryVector.length }
    };
  }
  if (options.topK !== undefined && (!Number.isInteger(options.topK) || options.topK <= 0)) {
    return { code: "invalid_vector_search_options", message: "topK 必须是大于 0 的整数。", details: { topK: options.topK } };
  }
  return undefined;
}

/**
 * @param row SQL 检索行。
 * @returns 现有 EmbeddedChunk DTO。
 */
function mapMatch(row: VectorMatchRow): EmbeddedChunk {
  const charStart = metadataNumber(row.metadata, "charStart") ?? 0;
  const charEnd = metadataNumber(row.metadata, "charEnd") ?? row.chunk_text.length;
  return {
    chunkId: row.chunk_id,
    id: row.chunk_id,
    documentId: row.document_id,
    source: row.source_uri,
    chunkIndex: row.chunk_index,
    text: row.chunk_text,
    charStart,
    charEnd,
    startOffset: metadataNumber(row.metadata, "startOffset") ?? charStart,
    endOffset: metadataNumber(row.metadata, "endOffset") ?? charEnd,
    ...(row.page_number !== null ? { page: row.page_number, pageNumber: row.page_number } : {}),
    ...(row.heading !== null ? { heading: row.heading } : {}),
    metadata: { ...row.metadata },
    embedding: parseVector(row.embedding),
    embeddingModel: row.embedding_model
  };
}

/** @param metadata chunk metadata。 @param key 字段。 @returns 数值或 undefined。 */
function metadataNumber(metadata: Record<string, string | number | boolean | null>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

/** @param vector 数值向量。 @returns pgvector 文本输入格式。 */
function vectorLiteral(vector: EmbeddingVector): string {
  return `[${vector.join(",")}]`;
}

/** @param value pgvector 文本输出。 @returns 数值向量。 */
function parseVector(value: string): number[] {
  return value.slice(1, -1).split(",").map(Number);
}

/** @param text chunk 正文。 @returns SHA-256 hex。 */
function checksumText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @returns 不泄漏 SQL 或 pg 原始消息的数据库失败。 */
function databaseFailure(): { ok: false; error: RagStructuredError } {
  return { ok: false, error: { code: "retrieval_failed", message: "PostgreSQL 向量存储暂时不可用，请稍后重试。" } };
}

/**
 * @param code 稳定 RAG 错误码。
 * @param message 安全消息。
 * @param details 非敏感上下文。
 * @returns VectorStore 失败结果。
 */
function failure(
  code: RagStructuredError["code"],
  message: string,
  details?: Record<string, unknown>
): { ok: false; error: RagStructuredError } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
