import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  assertValidOwnerScope,
  createPersistentChunkId,
  RagOwnerScopeValidationError,
  type NewRagChunkRecord,
  type RagChunkRecord,
  type RagDocumentRecord,
  type RagDocumentRepository,
  type RagDocumentScope,
  type RagDocumentSourceType,
  type RagDocumentSummary,
  type RagDocumentVersionRecord,
  type RagDocumentVersionStatus,
  type SaveRagIngestionInput,
  type SaveRagIngestionResult
} from "@aiagent/rag";
import { isPostgresUniqueViolation, postgresTimestampToIso, withTransaction } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

/** shared/demo 文档的唯一索引哨兵 owner，与 migration 中 coalesce 表达式保持一致。 */
const SHARED_OWNER_SENTINEL = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_WRITE_ATTEMPTS = 3;

/**
 * 创建 PostgreSQL RAG 文档 repository。
 *
 * 所有写路径在单事务内完成：文档行 `for update` 串行化同一文档的并发 ingestion，
 * 唯一约束冲突（23505）回滚后整体重查重试，保证幂等和版本递增在并发下成立。
 * 原始 pg 异常统一包装为 RepositoryError，不向调用方泄漏连接串或 SQL。
 *
 * @param pool PostgreSQL 连接池。
 * @returns RAG 文档 lineage repository。
 */
export function createPostgresRagDocumentRepository(pool: pg.Pool): RagDocumentRepository {
  return {
    async saveIngestion(input) {
      // owner/scope 组合在写边界先做结构化校验，避免非法数据抵达数据库 CHECK。
      try {
        assertValidOwnerScope(input);
      } catch (error) {
        throw toRagRepositoryError(error);
      }
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        try {
          return await withTransaction(pool, (client) => saveIngestionWithClient(client, input));
        } catch (error) {
          if (isPostgresUniqueViolation(error) && attempt < MAX_WRITE_ATTEMPTS) {
            continue;
          }
          throw toRagRepositoryError(error);
        }
      }
      throw new RepositoryError("database_unavailable", "RAG 文档写入在并发冲突后仍失败。");
    },
    async listDocuments(query) {
      return guardRead(async () => {
        const limit = normalizeListLimit(query.limit);
        const params: unknown[] = [query.ownerUserId];
        let cursorClause = "";
        if (query.cursor) {
          const cursor = parseDocumentCursor(query.cursor);
          params.push(cursor.createdAt, cursor.id);
          cursorClause = `and (d.created_at, d.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
        }
        params.push(limit + 1);
        const result = await pool.query<DocumentSummaryRow>(
          `select d.id, d.title, d.scope, d.source_type, d.external_id, d.created_at, d.updated_at,
                  v.version as latest_version, v.status as latest_status, v.source_uri as latest_source_uri
             from documents d
             left join lateral (
               select version, status, source_uri
                 from document_versions
                where document_id = d.id
                order by version desc
                limit 1
             ) v on true
            where d.deleted_at is null
              and (d.scope in ('shared', 'demo') or (d.scope = 'private' and d.owner_user_id = $1::uuid))
              ${cursorClause}
            order by d.created_at, d.id
            limit $${params.length}`,
          params
        );
        const page = result.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          documents: page.map(mapDocumentSummaryRow),
          nextCursor: result.rows.length > limit && last ? `${postgresTimestampToIso(last.created_at)}|${last.id}` : null
        };
      });
    },
    async listChunks(query) {
      return guardRead(async () => {
        const limit = normalizeListLimit(query.limit);
        const params: unknown[] = [query.ownerUserId];
        const clauses: string[] = [];
        if (query.documentId !== undefined) {
          params.push(query.documentId);
          clauses.push(`and d.id = $${params.length}::uuid`);
        }
        if (query.cursor) {
          params.push(query.cursor);
          clauses.push(`and c.id > $${params.length}::uuid`);
        }
        params.push(limit + 1);
        const result = await pool.query<ChunkRow>(
          `select c.id, c.document_version_id, c.chunk_index, c.chunk_text, c.heading, c.page_number,
                  c.line_start, c.line_end, c.token_count, c.chunker_version, c.metadata, c.content_checksum,
                  d.id as document_id, v.source_uri
             from chunks c
             join document_versions v on v.id = c.document_version_id
             join documents d on d.id = v.document_id
            where d.deleted_at is null
              and (d.scope in ('shared', 'demo') or (d.scope = 'private' and d.owner_user_id = $1::uuid))
              ${clauses.join("\n              ")}
            order by c.id
            limit $${params.length}`,
          params
        );
        const page = result.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          chunks: page.map(mapChunkRow),
          nextCursor: result.rows.length > limit && last ? last.id : null
        };
      });
    },
    async purgeSoftDeletedDocuments(olderThan) {
      // 软删除仅保留恢复窗口；到期后单语句物理删除，versions/chunks/正文随 FK cascade 清除。
      try {
        const result = await pool.query(
          "delete from documents where deleted_at is not null and deleted_at < $1::timestamptz",
          [olderThan]
        );
        return result.rowCount ?? 0;
      } catch (error) {
        throw toRagRepositoryError(error);
      }
    },
    async listVersions(query) {
      return guardRead(async () => {
        const document = await pool.query(
          `select id from documents
            where id = $1::uuid
              and deleted_at is null
              and (scope in ('shared', 'demo') or (scope = 'private' and owner_user_id = $2::uuid))`,
          [query.documentId, query.ownerUserId]
        );
        if (!document.rows[0]) {
          return undefined;
        }
        const result = await pool.query<VersionRow>(
          `select id, document_id, version, content_checksum, content_type, source_uri, storage_kind,
                  parser_version, status, error_code, error_message, error_details, created_at, indexed_at
             from document_versions
            where document_id = $1
            order by version`,
          [query.documentId]
        );
        return result.rows.map(mapVersionRow);
      });
    }
  };
}

interface DocumentRow {
  id: string;
  owner_user_id: string | null;
  scope: string;
  source_type: string;
  external_id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  content_checksum: string;
  content_type: string;
  source_uri: string;
  storage_kind: string;
  parser_version: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  error_details: Record<string, unknown> | null;
  created_at: Date | string;
  indexed_at: Date | string | null;
}

interface ChunkRow {
  id: string;
  document_version_id: string;
  chunk_index: number;
  chunk_text: string;
  heading: string | null;
  page_number: number | null;
  line_start: number | null;
  line_end: number | null;
  token_count: number | null;
  chunker_version: string;
  metadata: Record<string, string | number | boolean | null> | null;
  content_checksum: string;
  document_id: string;
  source_uri: string;
}

interface DocumentSummaryRow {
  id: string;
  title: string;
  scope: string;
  source_type: string;
  external_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  latest_version: number | null;
  latest_status: string | null;
  latest_source_uri: string | null;
}

/**
 * 单事务内执行 saveIngestion：查找/创建文档、按 checksum 命中或创建版本、应用终态 outcome。
 *
 * @param client 事务内 PostgreSQL client。
 * @param input ingestion 全量上下文与终态结果。
 * @returns 命中、新建或重试结果。
 */
async function saveIngestionWithClient(client: pg.PoolClient, input: SaveRagIngestionInput): Promise<SaveRagIngestionResult> {
  const document = await findOrLockDocument(client, input);
  const versionResult = await client.query<VersionRow>(
    `select id, document_id, version, content_checksum, content_type, source_uri, storage_kind,
            parser_version, status, error_code, error_message, error_details, created_at, indexed_at
       from document_versions
      where document_id = $1 and content_checksum = $2
      for update`,
    [document.id, input.contentChecksum]
  );
  const existingVersion = versionResult.rows[0];

  if (existingVersion?.status === "indexed") {
    return {
      kind: "existing",
      document,
      version: mapVersionRow(existingVersion),
      chunks: await selectChunks(client, existingVersion.id, document.id)
    };
  }

  if (existingVersion) {
    await applyOutcomeToVersion(client, existingVersion.id, input);
    await touchDocument(client, document.id, input);
    return {
      kind: "retried",
      document: { ...document, title: input.title, updatedAt: input.now },
      version: await getVersionById(client, existingVersion.id),
      chunks: await selectChunks(client, existingVersion.id, document.id)
    };
  }

  const nextVersion = await client.query<{ next_version: number }>(
    "select coalesce(max(version), 0) + 1 as next_version from document_versions where document_id = $1",
    [document.id]
  );
  const versionId = randomUUID();
  const failure = input.outcome.status === "failed" ? input.outcome.error : undefined;
  await client.query(
    `insert into document_versions(id, document_id, version, content_checksum, content_type, source_uri,
                                   storage_kind, content, parser_version, status,
                                   error_code, error_message, error_details, created_at, indexed_at)
     values ($1, $2, $3, $4, $5, $6, 'inline', $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      versionId,
      document.id,
      nextVersion.rows[0]?.next_version ?? 1,
      input.contentChecksum,
      input.contentType,
      input.sourceUri,
      input.content,
      input.parserVersion,
      input.outcome.status,
      failure?.code ?? null,
      failure?.message ?? null,
      failure?.details ? JSON.stringify(failure.details) : null,
      input.now,
      input.outcome.status === "indexed" ? input.now : null
    ]
  );
  if (input.outcome.status === "indexed") {
    await insertChunks(client, versionId, input.chunkerVersion, input.outcome.chunks);
  }
  await touchDocument(client, document.id, input);

  return {
    kind: "created",
    document: { ...document, title: input.title, updatedAt: input.now },
    version: await getVersionById(client, versionId),
    chunks: await selectChunks(client, versionId, document.id)
  };
}

/**
 * 按 (ownerUserId, externalId) 查找并锁定文档；不存在则创建（并发插入冲突由外层 23505 重试处理）。
 *
 * @param client 事务内 PostgreSQL client。
 * @param input ingestion 输入。
 * @returns 文档记录。
 */
async function findOrLockDocument(client: pg.PoolClient, input: SaveRagIngestionInput): Promise<RagDocumentRecord> {
  const found = await client.query<DocumentRow>(
    `select id, owner_user_id, scope, source_type, external_id, title, created_at, updated_at
       from documents
      where external_id = $2
        and deleted_at is null
        and coalesce(owner_user_id, $3::uuid) = coalesce($1::uuid, $3::uuid)
      for update`,
    [input.ownerUserId, input.externalId, SHARED_OWNER_SENTINEL]
  );
  if (found.rows[0]) {
    return mapDocumentRow(found.rows[0]);
  }
  const inserted = await client.query<DocumentRow>(
    `insert into documents(id, owner_user_id, scope, source_type, external_id, title, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)
     returning id, owner_user_id, scope, source_type, external_id, title, created_at, updated_at`,
    [randomUUID(), input.ownerUserId, input.scope, input.sourceType, input.externalId, input.title, input.now]
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new RepositoryError("database_unavailable", "RAG 文档创建失败。");
  }
  return mapDocumentRow(row);
}

/**
 * 把终态 outcome 应用到已有 failed 版本：成功时先删旧 chunk 再插入、置 indexed_at、清 error。
 *
 * @param client 事务内 PostgreSQL client。
 * @param versionId 目标版本 id。
 * @param input ingestion 输入。
 * @returns 更新完成 Promise。
 */
async function applyOutcomeToVersion(client: pg.PoolClient, versionId: string, input: SaveRagIngestionInput): Promise<void> {
  if (input.outcome.status === "failed") {
    await client.query(
      `update document_versions
          set status = 'failed', error_code = $2, error_message = $3, error_details = $4,
              indexed_at = null, parser_version = $5, content_type = $6, source_uri = $7, content = $8
        where id = $1`,
      [
        versionId,
        input.outcome.error.code,
        input.outcome.error.message,
        input.outcome.error.details ? JSON.stringify(input.outcome.error.details) : null,
        input.parserVersion,
        input.contentType,
        input.sourceUri,
        input.content
      ]
    );
    return;
  }
  await client.query("delete from chunks where document_version_id = $1", [versionId]);
  await client.query(
    `update document_versions
        set status = 'indexed', error_code = null, error_message = null, error_details = null,
            indexed_at = $2, parser_version = $3, content_type = $4, source_uri = $5, content = $6
      where id = $1`,
    [versionId, input.now, input.parserVersion, input.contentType, input.sourceUri, input.content]
  );
  await insertChunks(client, versionId, input.chunkerVersion, input.outcome.chunks);
}

/**
 * 版本变更后同步文档标题和更新时间。
 *
 * @param client 事务内 PostgreSQL client。
 * @param documentId 文档 id。
 * @param input ingestion 输入。
 * @returns 更新完成 Promise。
 */
async function touchDocument(client: pg.PoolClient, documentId: string, input: SaveRagIngestionInput): Promise<void> {
  await client.query("update documents set title = $2, updated_at = $3 where id = $1", [documentId, input.title, input.now]);
}

/**
 * 批量插入版本 chunks。
 *
 * @param client 事务内 PostgreSQL client。
 * @param versionId 所属版本 id。
 * @param chunkerVersion 切块器版本。
 * @param chunks 待插入 chunks。
 * @returns 插入完成 Promise。
 */
async function insertChunks(
  client: pg.PoolClient,
  versionId: string,
  chunkerVersion: string,
  chunks: readonly NewRagChunkRecord[]
): Promise<void> {
  for (const chunk of chunks) {
    await client.query(
      `insert into chunks(id, document_version_id, chunk_index, chunk_text, heading, page_number,
                          line_start, line_end, token_count, chunker_version, metadata, content_checksum)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomUUID(),
        versionId,
        chunk.chunkIndex,
        chunk.text,
        chunk.heading ?? null,
        chunk.pageNumber ?? null,
        chunk.lineStart ?? null,
        chunk.lineEnd ?? null,
        chunk.tokenCount ?? null,
        chunkerVersion,
        JSON.stringify(chunk.metadata),
        chunk.contentChecksum
      ]
    );
  }
}

/**
 * 读取版本全部 chunks 并投影为领域记录；chunkId 由文档身份和序号派生，与写入时一致。
 *
 * @param client 事务内 PostgreSQL client。
 * @param versionId 版本 id。
 * @param documentId 所属文档 id。
 * @returns chunk 记录数组。
 */
async function selectChunks(client: pg.PoolClient, versionId: string, documentId: string): Promise<RagChunkRecord[]> {
  const result = await client.query<ChunkRow>(
    `select c.id, c.document_version_id, c.chunk_index, c.chunk_text, c.heading, c.page_number,
            c.line_start, c.line_end, c.token_count, c.chunker_version, c.metadata, c.content_checksum,
            $2::uuid as document_id, v.source_uri
       from chunks c
       join document_versions v on v.id = c.document_version_id
      where c.document_version_id = $1
      order by c.chunk_index`,
    [versionId, documentId]
  );
  return result.rows.map(mapChunkRow);
}

/**
 * 按 id 重读版本记录，保证更新后返回数据库真实状态。
 *
 * @param client 事务内 PostgreSQL client。
 * @param versionId 版本 id。
 * @returns 版本记录。
 */
async function getVersionById(client: pg.PoolClient, versionId: string): Promise<RagDocumentVersionRecord> {
  const result = await client.query<VersionRow>(
    `select id, document_id, version, content_checksum, content_type, source_uri, storage_kind,
            parser_version, status, error_code, error_message, error_details, created_at, indexed_at
       from document_versions
      where id = $1`,
    [versionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new RepositoryError("database_unavailable", "RAG 文档版本读取失败。");
  }
  return mapVersionRow(row);
}

/**
 * @param row documents 行。 @returns 文档领域记录。
 */
function mapDocumentRow(row: DocumentRow): RagDocumentRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    scope: row.scope as RagDocumentScope,
    sourceType: row.source_type as RagDocumentSourceType,
    externalId: row.external_id,
    title: row.title,
    createdAt: postgresTimestampToIso(row.created_at),
    updatedAt: postgresTimestampToIso(row.updated_at)
  };
}

/**
 * @param row document_versions 行。 @returns 不含正文的版本领域记录。
 */
function mapVersionRow(row: VersionRow): RagDocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    contentChecksum: row.content_checksum,
    contentType: row.content_type,
    sourceUri: row.source_uri,
    storageKind: "inline",
    parserVersion: row.parser_version,
    status: row.status as RagDocumentVersionStatus,
    ...(row.error_code !== null
      ? {
          error: {
            code: row.error_code,
            message: row.error_message ?? "",
            ...(row.error_details ? { details: row.error_details } : {})
          }
        }
      : {}),
    createdAt: postgresTimestampToIso(row.created_at),
    ...(row.indexed_at !== null ? { indexedAt: postgresTimestampToIso(row.indexed_at) } : {})
  };
}

/**
 * @param row chunks join 行。 @returns chunk 领域记录。
 */
function mapChunkRow(row: ChunkRow): RagChunkRecord {
  return {
    chunkId: createPersistentChunkId(row.document_id, row.chunk_index),
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    source: row.source_uri,
    chunkIndex: row.chunk_index,
    text: row.chunk_text,
    ...(row.heading !== null ? { heading: row.heading } : {}),
    ...(row.page_number !== null ? { pageNumber: row.page_number } : {}),
    ...(row.line_start !== null ? { lineStart: row.line_start } : {}),
    ...(row.line_end !== null ? { lineEnd: row.line_end } : {}),
    ...(row.token_count !== null ? { tokenCount: row.token_count } : {}),
    chunkerVersion: row.chunker_version,
    metadata: row.metadata ?? {},
    contentChecksum: row.content_checksum
  };
}

/**
 * @param row documents 与最新版本 join 行。 @returns 文档摘要 DTO。
 */
function mapDocumentSummaryRow(row: DocumentSummaryRow): RagDocumentSummary {
  return {
    documentId: row.id,
    title: row.title,
    scope: row.scope as RagDocumentScope,
    sourceType: row.source_type as RagDocumentSourceType,
    externalId: row.external_id,
    sourceUri: row.latest_source_uri ?? "",
    latestVersion: row.latest_version ?? 0,
    latestStatus: (row.latest_status ?? "pending") as RagDocumentVersionStatus,
    createdAt: postgresTimestampToIso(row.created_at),
    updatedAt: postgresTimestampToIso(row.updated_at)
  };
}

/**
 * 解析文档分页 cursor（`createdAt|id`）；格式非法时抛结构化错误而不是拼进 SQL。
 *
 * @param cursor 上一页 nextCursor。
 * @returns 解码后的 createdAt 与 id。
 */
function parseDocumentCursor(cursor: string): { createdAt: string; id: string } {
  const separatorIndex = cursor.indexOf("|");
  const createdAt = separatorIndex > 0 ? cursor.slice(0, separatorIndex) : "";
  const id = separatorIndex > 0 ? cursor.slice(separatorIndex + 1) : "";
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw new RepositoryError("invalid_state_transition", "无效的文档分页 cursor。");
  }
  return { createdAt, id };
}

/**
 * 归一化分页 limit，缺省 50，上限 100。
 *
 * @param limit 调用方 limit。
 * @returns 合法 limit。
 */
function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

/**
 * 读路径统一错误边界。
 *
 * @param operation 读操作。
 * @returns 操作结果。
 */
async function guardRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toRagRepositoryError(error);
  }
}

/**
 * 把未知异常包装为 RepositoryError，保留 RepositoryError 原样透传；
 * rag 边界的 owner/scope 校验错误映射为 validation_failed。
 *
 * @param error 未知异常。
 * @returns 结构化 repository 错误。
 */
function toRagRepositoryError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) {
    return error;
  }
  if (error instanceof RagOwnerScopeValidationError) {
    return new RepositoryError("validation_failed", error.message, error);
  }
  return new RepositoryError("database_unavailable", "RAG 文档存储访问失败。", error);
}
