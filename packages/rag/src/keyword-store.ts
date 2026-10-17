import type { EmbeddedChunk, VectorSearchOptions } from "./types.js";
import { matchesVectorSearchFilter } from "./vector-math.js";

/**
 * 关键词候选存储端口：把"关键词候选来自哪份语料"这一外部依赖抽象出来，
 * 使 hybrid 检索在跨实例下读取同一份共享语料，消除进程内 `this.chunks` 的不一致。
 *
 * 设计取舍（P3）：打分逻辑（coverage / frequency / heading boost）仍由 retrieval.ts 的
 * `calculateKeywordScore` 在 TS 侧统一完成，保证可解释且单一事实源；本端口只负责"从共享存储
 * 读出与 queryTerms 命中的候选 chunk 子集"（含跨实例一致的 owner/scope/document 过滤）。
 * 这样生产走 Postgres 共享表、单测/本地 demo 走内存数组，检索打分语义完全一致。
 */
export interface KeywordCandidateStore {
  /**
   * 从共享存储读取与 queryTerms 命中的关键词语料候选。
   *
   * @param queryTerms 规范化后的查询词（retrieval.ts 已 tokenize）。
   * @param filter 与向量召回一致的 documentId/documentIds/source + owner 维度过滤。
   * @param candidateLimit 最大候选数（共享存储侧即可截断，避免拉取超大结果集）。
   * @returns 候选 chunk（不含 embedding，打分由 retrieval.ts 完成）。
   */
  findCandidateChunks(
    queryTerms: readonly string[],
    filter: VectorSearchOptions["filter"],
    candidateLimit: number
  ): Promise<readonly EmbeddedChunk[]>;
}

/**
 * 内存版关键词候选存储：直接扫描注入的 chunks 数组，命中判定与 retrieval.ts 的
 * `calculateKeywordScore` 一致（任一查询词出现在 chunk 文本或 heading 即视为命中）。
 * 用于单测、本地 demo 与无 DATABASE_URL 的退化路径；与 Postgres 实现共享同一打分口径。
 *
 * @param chunks 注入的内存语料（通常来自持久化 repository 的列表投影）。
 * @returns 内存关键词候选存储。
 */
export function createInMemoryKeywordCandidateStore(
  chunks: readonly EmbeddedChunk[]
): KeywordCandidateStore {
  return {
    async findCandidateChunks(queryTerms, filter, candidateLimit) {
      const loweredTerms = queryTerms.map((term) => term.toLowerCase());
      return chunks
        .filter((chunk) => matchesVectorSearchFilter(chunk, filter))
        .filter((chunk) => {
          const haystack = `${chunk.heading ?? ""} ${chunk.text}`.toLowerCase();
          return loweredTerms.some((term) => haystack.includes(term));
        })
        .slice(0, candidateLimit);
    }
  };
}

/** 判断 chunk 是否命中任一查询词（CJK / 拉丁统一按"词出现于文本"匹配，对齐内存打分口径）。 */
export function chunkMatchesQueryTerms(chunk: EmbeddedChunk, queryTerms: readonly string[]): boolean {
  const haystack = `${chunk.heading ?? ""} ${chunk.text}`.toLowerCase();
  return queryTerms.some((term) => haystack.includes(term.toLowerCase()));
}
