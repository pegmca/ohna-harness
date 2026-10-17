import type pg from "pg";
import type { EmbeddedChunk, KeywordCandidateStore, VectorSearchOptions } from "@aiagent/rag";

/**
 * 关键词候选的 Postgres 共享存储实现（P3 外置）。
 *
 * 与向量召回共用同一份 `chunks` 事实源：关键词候选不再依赖进程内 `this.chunks`，
 * 而是直接从共享 `chunks` 表按 owner/scope/document 授权过滤 + 词命中（ILIKE，CJK 安全）
 * 读取，跨实例一致。
 *
 * 设计取舍：
 * - 打分（coverage / frequency / heading boost）仍由 @aiagent/rag 的 `calculateKeywordScore`
 *   在 TS 侧统一完成，端口只返回候选 chunk 子集，保证与内存实现同一打分口径；
 * - 词命中用 `ILIKE ANY('%term%')` 而非常规 tsvector：内置 simple 词典对中文按整段而非单字分词，
 *   会丢失"资产质量"这类 CJK 短语匹配；ILIKE 子串匹配在 UTF-8 下对 CJK/拉丁一致可用；
 * - 命中谓词改为在 `chunk_text || ' ' || coalesce(heading, '')` 这一与索引完全一致的表达式上做 ILIKE，
 *   由迁移 0300 的 `idx_chunks_keyword_trgm`（pg_trgm gin 三元组索引）加速，避免顺序扫描（P3 优化）。
 *   选 pg_trgm 而非 tsvector：前者按字符三元组切分、不依赖词典，对 CJK 子串同样有效（to_tsquery 默认词典对中文分词会丢短语）。
 */
export function createPostgresKeywordCandidateStore(
  pool: pg.Pool,
  options: { ownerUserId: string | null }
): KeywordCandidateStore {
  const ownerUserId = options.ownerUserId;
  return {
    async findCandidateChunks(queryTerms, filter, candidateLimit) {
      const params: unknown[] = [ownerUserId ?? null];
      const filters: string[] = [];
      if (filter?.documentId !== undefined) {
        params.push(filter.documentId);
        filters.push(`and d.id = $${params.length}::uuid`);
      }
      if (filter?.documentIds !== undefined) {
        params.push(filter.documentIds);
        filters.push(`and d.id = any($${params.length}::uuid[])`);
      }
      if (filter?.source !== undefined) {
        params.push(filter.source);
        filters.push(`and v.source_uri = $${params.length}`);
      }
      // 每个查询词转成 `%term%` 子串模式；空数组时 ANY('{}') 对所有行不成立，等价于"无候选"。
      const patterns = queryTerms.map((term) => `%${term}%`);
      params.push(patterns);
      const patternIndex = params.length;
      params.push(Math.max(1, Math.floor(candidateLimit)));
      const limitIndex = params.length;

      const sql = `
        with authorized_candidates as materialized (
          select
            v.id::text || '_' || c.chunker_version || '_chunk_' || lpad(c.chunk_index::text, 4, '0') as chunk_id,
            d.id as document_id,
            v.source_uri,
            c.chunk_index,
            c.chunk_text,
            c.heading,
            c.page_number,
            c.metadata
          from chunks c
          join document_versions v on v.id = c.document_version_id
          join documents d on d.id = v.document_id
          where d.deleted_at is null
            and v.status = 'indexed'
            and (d.scope in ('shared', 'demo') or (d.scope = 'private' and d.owner_user_id = $1::uuid))
            ${filters.join("\n            ")}
            and (
              c.chunk_text || ' ' || coalesce(c.heading, '')
            ) ilike any($${patternIndex}::text[])
        )
        select
          chunk_id, document_id, source_uri, chunk_index, chunk_text, heading, page_number, metadata
        from authorized_candidates
        order by chunk_index
        limit $${limitIndex}`;

      try {
        const result = await pool.query<KeywordChunkRow>(sql, params);
        return result.rows.map(mapKeywordChunk);
      } catch {
        // 检索边界错误：返回空候选（TS 侧打分得到空结果），不向上抛，与向量召回失败收敛一致。
        return [];
      }
    }
  };
}

/** 关键词候选行（仅取打分所需字段，embedding 由 TS 侧打分忽略）。 */
interface KeywordChunkRow {
  chunk_id: string;
  document_id: string;
  source_uri: string;
  chunk_index: number;
  chunk_text: string;
  heading: string | null;
  page_number: number | null;
  metadata: Record<string, string | number | boolean | null>;
}

/** 从 metadata 读取数值型偏移，缺失或类型不符时回退 defaultValue。 */
function metadataNumber(
  metadata: Record<string, string | number | boolean | null>,
  key: string
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

/** 把关键词候选行映射为 EmbeddedChunk（embedding 留空：关键词打分只用 heading/text）。 */
function mapKeywordChunk(row: KeywordChunkRow): EmbeddedChunk {
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
    // embedding 不参与关键词打分，留空避免把整库向量拉入进程内存（P3 外置后本就不需要）。
    embedding: [],
    embeddingModel: ""
  };
}
