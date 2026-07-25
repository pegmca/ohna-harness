import {
  canTransitionCitationVerifierStatus,
  type CitationRecord,
  type CitationRepository,
  type CitationSourceProjection,
  type CitationVerifierStatus,
  type CitationVerifierUpdateResult,
  type NewCitationInput
} from "@aiagent/rag";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { postgresTimestampToIso } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

/**
 * 创建 Citation PostgreSQL adapter。
 *
 * 写入路径不在本 adapter 上暴露：message/artifact 与各自 citations 的原子性由
 * run-repository / artifact repository 在同一事务内调用本文件的 insert 辅助函数保证。
 *
 * @param pool PostgreSQL 连接池。
 * @returns Citation repository。
 */
export function createPostgresCitationRepository(pool: pg.Pool): CitationRepository {
  return {
    async listMessageCitations(userId, messageId) {
      try {
        const owned = await pool.query("select 1 from messages where id=$1 and user_id=$2", [messageId, userId]);
        if (!owned.rowCount) return undefined;
        const result = await pool.query<CitationJoinRow>(
          `${CITATION_SELECT} from message_citations r ${CITATION_JOINS}
            where r.message_id=$1 and r.user_id=$2 order by r.ordinal`,
          [messageId, userId]
        );
        return result.rows.map((row) => mapCitationRecord(row, userId));
      } catch (cause) {
        throw mapCitationError(cause);
      }
    },
    async listArtifactCitations(userId, artifactId) {
      try {
        const owned = await pool.query(
          "select 1 from artifacts where id=$1 and user_id=$2 and deleted_at is null",
          [artifactId, userId]
        );
        if (!owned.rowCount) return undefined;
        const result = await pool.query<CitationJoinRow>(
          `${CITATION_SELECT} from artifact_citations r ${CITATION_JOINS}
            where r.artifact_id=$1 and r.user_id=$2 order by r.ordinal`,
          [artifactId, userId]
        );
        return result.rows.map((row) => mapCitationRecord(row, userId));
      } catch (cause) {
        throw mapCitationError(cause);
      }
    },
    async updateMessageCitationVerifierStatus(userId, citationId, next) {
      return updateVerifierStatus(pool, "message_citations", userId, citationId, next);
    },
    async updateArtifactCitationVerifierStatus(userId, citationId, next) {
      return updateVerifierStatus(pool, "artifact_citations", userId, citationId, next);
    }
  };
}

const CITATION_SELECT = `select r.id, r.ordinal, r.claim, r.quote, r.score, r.verifier_status, r.created_at,
  r.chunk_id, r.document_version_id,
  c.chunk_index, c.chunker_version, c.heading as chunk_heading,
  dv.document_id, dv.source_uri,
  d.scope as document_scope, d.owner_user_id as document_owner_user_id, d.deleted_at as document_deleted_at`;

const CITATION_JOINS = `left join chunks c on c.id = r.chunk_id
  left join document_versions dv on dv.id = r.document_version_id
  left join documents d on d.id = dv.document_id`;

interface CitationJoinRow {
  id: string;
  ordinal: number;
  claim: string;
  quote: string;
  score: number | null;
  verifier_status: CitationVerifierStatus;
  created_at: Date | string;
  chunk_id: string | null;
  document_version_id: string | null;
  chunk_index: number | null;
  chunker_version: string | null;
  chunk_heading: string | null;
  document_id: string | null;
  source_uri: string | null;
  document_scope: string | null;
  document_owner_user_id: string | null;
  document_deleted_at: Date | string | null;
}

/**
 * 把 join 行投影为授权后的 citation 记录。
 *
 * 来源可见谓词与 RagDocumentRepository 一致：shared/demo 全员可见，private 仅 owner，
 * 软删除文档一律不可见；不可见时只保留序号/claim/校验状态，不返回 quote 快照与 source URI。
 *
 * @param row join 行。
 * @param userId 当前用户。
 * @returns 授权投影后的记录。
 */
function mapCitationRecord(row: CitationJoinRow, userId: string): CitationRecord {
  return {
    citationId: row.id,
    ordinal: row.ordinal,
    claim: row.claim,
    verifierStatus: row.verifier_status,
    createdAt: postgresTimestampToIso(row.created_at),
    source: projectSource(row, userId)
  };
}

/** @param row join 行。 @param userId 当前用户。 @returns 来源可访问性投影。 */
function projectSource(row: CitationJoinRow, userId: string): CitationSourceProjection {
  if (!isResolvedSource(row)) {
    return {
      status: "unresolved",
      quote: row.quote,
      ...(row.score !== null ? { score: row.score } : {})
    };
  }
  if (!isSourceVisible(row, userId)) return { status: "inaccessible" };
  return {
    status: "accessible",
    chunkId: createDomainChunkId(row.document_version_id as string, row.chunker_version as string, row.chunk_index as number),
    documentId: row.document_id as string,
    documentVersionId: row.document_version_id as string,
    sourceUri: row.source_uri ?? "",
    ...(row.chunk_heading !== null ? { heading: row.chunk_heading } : {}),
    chunkIndex: row.chunk_index as number,
    quote: row.quote,
    ...(row.score !== null ? { score: row.score } : {})
  };
}

/** @param row join 行。 @returns 是否解析到完整的 chunk/version 回链。 */
function isResolvedSource(row: CitationJoinRow): boolean {
  return row.chunk_id !== null && row.document_version_id !== null
    && row.chunk_index !== null && row.chunker_version !== null && row.document_id !== null;
}

/**
 * 来源可见谓词与 RagDocumentRepository 一致：shared/demo 全员可见，private 仅 owner，软删除不可见。
 *
 * @param row join 行。
 * @param userId 当前用户。
 * @returns 可见返回 true。
 */
function isSourceVisible(row: CitationJoinRow, userId: string): boolean {
  if (row.document_deleted_at !== null) return false;
  return row.document_scope === "shared" || row.document_scope === "demo" || row.document_owner_user_id === userId;
}

/**
 * 重建持久化 chunk 的域 id，与 rag package 的 createPersistentChunkId 保持同一格式。
 *
 * @param documentVersionId 文档版本 ID。
 * @param chunkerVersion 切块器版本。
 * @param chunkIndex chunk 序号。
 * @returns 域 chunk id。
 */
function createDomainChunkId(documentVersionId: string, chunkerVersion: string, chunkIndex: number): string {
  return `${documentVersionId}_${chunkerVersion}_chunk_${String(chunkIndex).padStart(4, "0")}`;
}

/**
 * 按域 chunk id 解析 chunk/version 外键；无法解析时返回空外键（保留 quote 快照语义）。
 *
 * @param executor 当前事务。
 * @param domainChunkId 域 chunk id。
 * @returns chunk/version 外键或空。
 */
async function resolveChunkReference(
  executor: Pick<pg.Pool | pg.PoolClient, "query">,
  domainChunkId: string | undefined
): Promise<{ chunkId: string | null; documentVersionId: string | null }> {
  if (!domainChunkId) return { chunkId: null, documentVersionId: null };
  const result = await executor.query<{ id: string; document_version_id: string }>(
    `select id, document_version_id from chunks
      where $1 = document_version_id::text || '_' || chunker_version || '_chunk_' || lpad(chunk_index::text, 4, '0')`,
    [domainChunkId]
  );
  const row = result.rows[0];
  return row ? { chunkId: row.id, documentVersionId: row.document_version_id } : { chunkId: null, documentVersionId: null };
}

/**
 * 在同一事务内写入 message citations；调用方负责事务边界与 message 写入的原子性。
 *
 * 不做 conflict 忽略：assistant message 终态写入由 Run 状态 CAS 保证只发生一次，
 * 重复 ordinal 应触发唯一约束回滚而不是静默吞掉。
 *
 * @param client 当前事务。
 * @param input 归属、message ID、citation 输入与创建时间。
 * @returns 写入完成。
 */
export async function insertMessageCitations(
  client: pg.PoolClient,
  input: { userId: string; messageId: string; citations: NewCitationInput[]; createdAt: string }
): Promise<void> {
  for (const citation of input.citations) {
    const reference = await resolveChunkReference(client, citation.chunkId);
    await client.query(
      `insert into message_citations(id,user_id,message_id,chunk_id,document_version_id,ordinal,claim,quote,score,verifier_status,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), input.userId, input.messageId, reference.chunkId, reference.documentVersionId,
        citation.ordinal, citation.claim, citation.quote, citation.score ?? null,
        citation.verifierStatus ?? "unverified", input.createdAt]
    );
  }
}

/**
 * 在同一事务内写入 artifact citations；重复保存相同 artifact 时按 (artifact_id, ordinal) 幂等忽略。
 *
 * @param client 当前事务。
 * @param input 归属、artifact ID、citation 输入与创建时间。
 * @returns 写入完成。
 */
export async function insertArtifactCitations(
  client: pg.PoolClient,
  input: { userId: string; artifactId: string; citations: NewCitationInput[]; createdAt: string }
): Promise<void> {
  for (const citation of input.citations) {
    const reference = await resolveChunkReference(client, citation.chunkId);
    await client.query(
      `insert into artifact_citations(id,user_id,artifact_id,chunk_id,document_version_id,ordinal,claim,quote,score,verifier_status,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (artifact_id, ordinal) do nothing`,
      [randomUUID(), input.userId, input.artifactId, reference.chunkId, reference.documentVersionId,
        citation.ordinal, citation.claim, citation.quote, citation.score ?? null,
        citation.verifierStatus ?? "unverified", input.createdAt]
    );
  }
}

/**
 * 删除 artifact 的全部 citations（软删除生成物时级联删除关系）。
 *
 * @param client 当前事务。
 * @param artifactId artifact ID。
 * @returns 删除完成。
 */
export async function deleteArtifactCitations(client: pg.PoolClient, artifactId: string): Promise<void> {
  await client.query("delete from artifact_citations where artifact_id=$1", [artifactId]);
}

/**
 * 显式状态迁移更新 verifier 状态；行锁 + 应用层迁移规则保证不覆盖人工/终态结果。
 *
 * @param pool 连接池。
 * @param table 目标 citation 表。
 * @param userId 当前用户。
 * @param citationId 引用记录 ID。
 * @param next 目标状态。
 * @returns 更新结果。
 */
async function updateVerifierStatus(
  pool: pg.Pool,
  table: "message_citations" | "artifact_citations",
  userId: string,
  citationId: string,
  next: CitationVerifierStatus
): Promise<CitationVerifierUpdateResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<{ verifier_status: CitationVerifierStatus }>(
      `select verifier_status from ${table} where id=$1 and user_id=$2 for update`,
      [citationId, userId]
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("rollback");
      return { status: "not_found" };
    }
    if (!canTransitionCitationVerifierStatus(row.verifier_status, next)) {
      await client.query("rollback");
      return { status: "invalid_transition", current: row.verifier_status };
    }
    if (row.verifier_status !== next) {
      await client.query(`update ${table} set verifier_status=$3 where id=$1 and user_id=$2`, [citationId, userId, next]);
    }
    await client.query("commit");
    return { status: "updated", verifierStatus: next };
  } catch (cause) {
    await client.query("rollback").catch(() => undefined);
    throw mapCitationError(cause);
  } finally {
    client.release();
  }
}

/** @param cause 内部异常。 @returns 不泄漏 PostgreSQL 细节的结构化错误。 */
function mapCitationError(cause: unknown): RepositoryError {
  return cause instanceof RepositoryError
    ? cause
    : new RepositoryError("database_unavailable", "Citation persistence is temporarily unavailable.", cause);
}
