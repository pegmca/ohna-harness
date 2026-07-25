import type { DataSourceDocumentDto } from "@aiagent/types";

/** RAG 文档可见范围：private 仅 owner 可见，shared/demo 对所有调用方可见。 */
export type RagDocumentScope = "private" | "shared" | "demo";

/** 文档摘要：与 API 层 DataSourceDocumentDto 同构，是 listDocuments 的返回元素。 */
export type RagDocumentSummary = DataSourceDocumentDto;

/** RAG 文档来源类型，与 filings 来源枚举保持一致。 */
export type RagDocumentSourceType = "local_file" | "remote_url" | "mock_text";

/** 文档版本状态：failed 是终态但允许同 checksum 重试覆盖。 */
export type RagDocumentVersionStatus = "pending" | "indexed" | "failed";

/**
 * 逻辑文档记录：跨版本的稳定身份，ownerUserId 为空表示 shared/demo 文档。
 */
export interface RagDocumentRecord {
  id: string;
  ownerUserId: string | null;
  scope: RagDocumentScope;
  sourceType: RagDocumentSourceType;
  externalId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 文档版本记录：不包含 content 正文，避免列表查询泄漏全文。
 */
export interface RagDocumentVersionRecord {
  id: string;
  documentId: string;
  version: number;
  contentChecksum: string;
  contentType: string;
  sourceUri: string;
  storageKind: "inline";
  parserVersion: string;
  status: RagDocumentVersionStatus;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  indexedAt?: string;
}

/**
 * 待持久化的新 chunk：chunkId 由 adapter 依据文档身份和序号派生，调用方不提供。
 */
export interface NewRagChunkRecord {
  chunkIndex: number;
  text: string;
  heading?: string;
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  tokenCount?: number;
  metadata: Record<string, string | number | boolean | null>;
  contentChecksum: string;
}

/**
 * 持久化 chunk 记录：包含重建 RagChunkDto 所需的全部字段。
 */
export interface RagChunkRecord {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  source: string;
  chunkIndex: number;
  text: string;
  heading?: string;
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  tokenCount?: number;
  chunkerVersion: string;
  metadata: Record<string, string | number | boolean | null>;
  contentChecksum: string;
}

/** saveIngestion 的终态结果：失败保存结构化错误，成功携带完整 chunks。 */
export type RagIngestionOutcome =
  | {
      status: "failed";
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    }
  | {
      status: "indexed";
      chunks: NewRagChunkRecord[];
    };

/** saveIngestion 输入：事务边界由 adapter 保证，now 由调用方注入便于测试。 */
export interface SaveRagIngestionInput {
  ownerUserId: string | null;
  scope: RagDocumentScope;
  sourceType: RagDocumentSourceType;
  externalId: string;
  title: string;
  sourceUri: string;
  contentType: string;
  contentChecksum: string;
  content: string;
  parserVersion: string;
  chunkerVersion: string;
  outcome: RagIngestionOutcome;
  now: string;
}

/**
 * saveIngestion 结果：
 * - existing：同 checksum 版本已 indexed，幂等命中，未写入任何新行；
 * - created：新建了不可变版本（含 failed 终态）；
 * - retried：已有 failed 版本被同 checksum 重试更新。
 */
export type SaveRagIngestionResult =
  | {
      kind: "existing";
      document: RagDocumentRecord;
      version: RagDocumentVersionRecord;
      chunks: RagChunkRecord[];
    }
  | {
      kind: "created";
      document: RagDocumentRecord;
      version: RagDocumentVersionRecord;
      chunks: RagChunkRecord[];
    }
  | {
      kind: "retried";
      document: RagDocumentRecord;
      version: RagDocumentVersionRecord;
      chunks: RagChunkRecord[];
    };

/** 文档分页查询：cursor 为上一页 nextCursor，limit 缺省 50。 */
export interface ListRagDocumentsQuery {
  ownerUserId: string | null;
  cursor?: string;
  limit?: number;
}

/** chunk 分页查询：可按 documentId 过滤，授权谓词与文档列表一致。 */
export interface ListRagChunksQuery {
  ownerUserId: string | null;
  documentId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * RAG 文档 lineage repository port。
 *
 * 领域 package 只声明端口；PostgreSQL adapter 在 packages/database 实现，
 * 内存实现供单元测试与本地 demo 使用。所有读方法强制 scope 授权：
 * 可见条件为 `scope in ('shared','demo') or (scope='private' and ownerUserId = $ownerUserId)`，
 * ownerUserId 为空时只能看到 shared/demo。
 */
export interface RagDocumentRepository {
  /**
   * 在单个事务中落 ingestion lineage。
   *
   * 语义：按 (ownerUserId, externalId) 查找或创建 document；再按 (documentId, contentChecksum)
   * 查找版本——已 indexed 返回 existing，failed 用新 outcome 更新同一行（成功时先删除旧 chunk
   * 再插入、写入 indexed_at、清空 error），不存在则以 max(version)+1 插入新版本。
   *
   * @param input ingestion 全量上下文与终态结果。
   * @returns 命中、新建或重试的文档、版本与 chunks。
   */
  saveIngestion(input: SaveRagIngestionInput): Promise<SaveRagIngestionResult>;

  /**
   * 按 created_at+id 稳定排序分页列出可见文档（排除软删除）。
   *
   * @param query owner、cursor 与 limit。
   * @returns 文档摘要页与下一页 cursor。
   */
  listDocuments(query: ListRagDocumentsQuery): Promise<{ documents: RagDocumentSummary[]; nextCursor: string | null }>;

  /**
   * 分页列出可见 chunk，授权谓词经 versions/documents join 后与文档列表一致。
   *
   * @param query owner、可选 documentId、cursor 与 limit。
   * @returns chunk 记录页与下一页 cursor。
   */
  listChunks(query: ListRagChunksQuery): Promise<{ chunks: RagChunkRecord[]; nextCursor: string | null }>;

  /**
   * 列出文档全部版本（不含 content 正文）；文档不存在或无权限时返回 undefined。
   *
   * @param query 文档 id 与调用方 owner。
   * @returns 版本数组；不可见时返回 undefined。
   */
  listVersions(query: { documentId: string; ownerUserId: string | null }): Promise<RagDocumentVersionRecord[] | undefined>;
}

/**
 * 派生持久化 chunk 的稳定域 id。
 *
 * chunkId 由文档身份和序号决定而不是随机生成，保证幂等重读、向量索引和 citation
 * 在不同进程、不同时间点拿到完全一致的身份。
 *
 * @param documentId 持久化文档 id。
 * @param chunkIndex 版本内 chunk 序号。
 * @returns 稳定 chunk id。
 */
export function createPersistentChunkId(documentId: string, chunkIndex: number): string {
  return `${documentId}_chunk_${String(chunkIndex).padStart(4, "0")}`;
}

/**
 * 判断文档对给定 owner 是否可见，与 SQL 授权谓词保持同一语义。
 *
 * @param document 文档记录。
 * @param ownerUserId 调用方 user id；空表示匿名。
 * @returns 可见返回 true。
 */
export function isRagDocumentVisible(document: Pick<RagDocumentRecord, "scope" | "ownerUserId">, ownerUserId: string | null): boolean {
  if (document.scope === "shared" || document.scope === "demo") {
    return true;
  }
  return ownerUserId !== null && document.ownerUserId === ownerUserId;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

interface StoredVersion extends RagDocumentVersionRecord {
  content: string;
}

interface StoredChunk extends RagChunkRecord {
  rowId: string;
}

/**
 * 创建内存 RAG 文档 repository。
 *
 * 内存实现是单元测试和本地 demo adapter，不提供跨进程共享；语义与 PostgreSQL
 * adapter 完全一致（幂等、版本递增、失败重试、scope 授权、稳定 cursor 分页）。
 *
 * @returns 实现 RagDocumentRepository 的内存实例。
 */
export function createInMemoryRagDocumentRepository(): RagDocumentRepository {
  return new InMemoryRagDocumentRepository();
}

/**
 * 内存 repository 实现，用 Map 模拟唯一约束和事务语义；单进程内天然串行。
 */
class InMemoryRagDocumentRepository implements RagDocumentRepository {
  private readonly documentsById = new Map<string, RagDocumentRecord>();
  private readonly versionsById = new Map<string, StoredVersion>();
  private readonly chunksByVersionId = new Map<string, StoredChunk[]>();
  private sequence = 0;

  /**
   * 落 ingestion lineage；语义见 port 注释。
   *
   * @param input ingestion 全量上下文与终态结果。
   * @returns 命中、新建或重试结果。
   */
  public async saveIngestion(input: SaveRagIngestionInput): Promise<SaveRagIngestionResult> {
    const document = this.findOrCreateDocument(input);
    const existingVersion = [...this.versionsById.values()].find(
      (version) => version.documentId === document.id && version.contentChecksum === input.contentChecksum
    );

    if (existingVersion?.status === "indexed") {
      return {
        kind: "existing",
        document: cloneDocument(document),
        version: toVersionRecord(existingVersion),
        chunks: this.readChunks(existingVersion.id)
      };
    }

    if (existingVersion) {
      const retried = this.applyOutcome(existingVersion, input);
      this.touchDocument(document, input);
      return {
        kind: "retried",
        document: cloneDocument(document),
        version: toVersionRecord(retried),
        chunks: this.readChunks(retried.id)
      };
    }

    const nextVersion = Math.max(
      0,
      ...[...this.versionsById.values()]
        .filter((version) => version.documentId === document.id)
        .map((version) => version.version)
    ) + 1;
    const version: StoredVersion = {
      id: this.nextId("version"),
      documentId: document.id,
      version: nextVersion,
      contentChecksum: input.contentChecksum,
      contentType: input.contentType,
      sourceUri: input.sourceUri,
      storageKind: "inline",
      content: input.content,
      parserVersion: input.parserVersion,
      status: "pending",
      createdAt: input.now
    };
    this.versionsById.set(version.id, version);
    const created = this.applyOutcome(version, input);
    this.touchDocument(document, input);

    return {
      kind: "created",
      document: cloneDocument(document),
      version: toVersionRecord(created),
      chunks: this.readChunks(created.id)
    };
  }

  /**
   * 分页列出可见文档摘要，cursor 编码 `createdAt|id`。
   *
   * @param query owner、cursor 与 limit。
   * @returns 文档摘要页与下一页 cursor。
   */
  public async listDocuments(query: ListRagDocumentsQuery): Promise<{ documents: DataSourceDocumentDto[]; nextCursor: string | null }> {
    const limit = normalizeLimit(query.limit);
    const visible = [...this.documentsById.values()]
      .filter((document) => isRagDocumentVisible(document, query.ownerUserId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const startIndex = query.cursor ? visible.findIndex((document) => encodeDocumentCursor(document) === query.cursor) + 1 : 0;
    const page = visible.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
    const last = page.at(-1);

    return {
      documents: page.map((document) => this.toDocumentSummary(document)),
      nextCursor: last && visible.length > Math.max(startIndex, 0) + limit ? encodeDocumentCursor(last) : null
    };
  }

  /**
   * 分页列出可见 chunk，按内部 rowId 稳定排序并作为 cursor。
   *
   * @param query owner、可选 documentId、cursor 与 limit。
   * @returns chunk 记录页与下一页 cursor。
   */
  public async listChunks(query: ListRagChunksQuery): Promise<{ chunks: RagChunkRecord[]; nextCursor: string | null }> {
    const limit = normalizeLimit(query.limit);
    const visible = [...this.chunksByVersionId.values()]
      .flat()
      .filter((chunk) => {
        if (query.documentId !== undefined && chunk.documentId !== query.documentId) return false;
        const document = this.documentsById.get(chunk.documentId);
        return document !== undefined && isRagDocumentVisible(document, query.ownerUserId);
      })
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const startIndex = query.cursor ? visible.findIndex((chunk) => chunk.rowId === query.cursor) + 1 : 0;
    const page = visible.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
    const last = page.at(-1);

    return {
      chunks: page.map(toChunkRecord),
      nextCursor: last && visible.length > Math.max(startIndex, 0) + limit ? last.rowId : null
    };
  }

  /**
   * 列出文档版本；文档不存在或无权限时返回 undefined。
   *
   * @param query 文档 id 与调用方 owner。
   * @returns 版本数组或 undefined。
   */
  public async listVersions(query: { documentId: string; ownerUserId: string | null }): Promise<RagDocumentVersionRecord[] | undefined> {
    const document = this.documentsById.get(query.documentId);
    if (!document || !isRagDocumentVisible(document, query.ownerUserId)) {
      return undefined;
    }
    return [...this.versionsById.values()]
      .filter((version) => version.documentId === query.documentId)
      .sort((left, right) => left.version - right.version)
      .map(toVersionRecord);
  }

  /**
   * 按 (ownerUserId, externalId) 查找或创建文档。
   *
   * @param input ingestion 输入。
   * @returns 已存在或新建的文档记录。
   */
  private findOrCreateDocument(input: SaveRagIngestionInput): RagDocumentRecord {
    const existing = [...this.documentsById.values()].find(
      (document) => document.ownerUserId === input.ownerUserId && document.externalId === input.externalId
    );
    if (existing) return existing;
    const document: RagDocumentRecord = {
      id: this.nextId("document"),
      ownerUserId: input.ownerUserId,
      scope: input.scope,
      sourceType: input.sourceType,
      externalId: input.externalId,
      title: input.title,
      createdAt: input.now,
      updatedAt: input.now
    };
    this.documentsById.set(document.id, document);
    return document;
  }

  /**
   * 把终态 outcome 应用到版本：成功时替换 chunks、置 indexed_at 并清 error。
   *
   * @param version 目标版本。
   * @param input ingestion 输入。
   * @returns 更新后的版本。
   */
  private applyOutcome(version: StoredVersion, input: SaveRagIngestionInput): StoredVersion {
    version.parserVersion = input.parserVersion;
    version.contentType = input.contentType;
    version.sourceUri = input.sourceUri;
    version.content = input.content;
    if (input.outcome.status === "failed") {
      version.status = "failed";
      version.error = { ...input.outcome.error };
      version.indexedAt = undefined;
    } else {
      version.status = "indexed";
      version.error = undefined;
      version.indexedAt = input.now;
      this.chunksByVersionId.set(
        version.id,
        input.outcome.chunks.map((chunk) => ({
          rowId: this.nextId("chunk"),
          chunkId: createPersistentChunkId(version.documentId, chunk.chunkIndex),
          documentId: version.documentId,
          documentVersionId: version.id,
          source: input.sourceUri,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
          ...(chunk.pageNumber !== undefined ? { pageNumber: chunk.pageNumber } : {}),
          ...(chunk.lineStart !== undefined ? { lineStart: chunk.lineStart } : {}),
          ...(chunk.lineEnd !== undefined ? { lineEnd: chunk.lineEnd } : {}),
          ...(chunk.tokenCount !== undefined ? { tokenCount: chunk.tokenCount } : {}),
          chunkerVersion: input.chunkerVersion,
          metadata: { ...chunk.metadata },
          contentChecksum: chunk.contentChecksum
        }))
      );
    }
    return version;
  }

  /**
   * 版本变更后同步文档标题和更新时间。
   *
   * @param document 文档记录。
   * @param input ingestion 输入。
   */
  private touchDocument(document: RagDocumentRecord, input: SaveRagIngestionInput): void {
    document.title = input.title;
    document.updatedAt = input.now;
  }

  /**
   * 读取版本 chunks 的深拷贝，避免调用方修改内部状态。
   *
   * @param versionId 版本 id。
   * @returns chunk 记录数组。
   */
  private readChunks(versionId: string): RagChunkRecord[] {
    return (this.chunksByVersionId.get(versionId) ?? []).map(toChunkRecord);
  }

  /**
   * 投影文档摘要，附带最新版本号、状态和 sourceUri。
   *
   * @param document 文档记录。
   * @returns 文档摘要 DTO。
   */
  private toDocumentSummary(document: RagDocumentRecord): DataSourceDocumentDto {
    const latest = [...this.versionsById.values()]
      .filter((version) => version.documentId === document.id)
      .sort((left, right) => right.version - left.version)[0];
    return {
      documentId: document.id,
      title: document.title,
      scope: document.scope,
      sourceType: document.sourceType,
      externalId: document.externalId,
      sourceUri: latest?.sourceUri ?? "",
      latestVersion: latest?.version ?? 0,
      latestStatus: latest?.status ?? "pending",
      createdAt: document.createdAt,
      updatedAt: document.updatedAt
    };
  }

  /**
   * 生成单调递增内部 id，保证内存分页 cursor 顺序稳定。
   *
   * @param prefix id 前缀。
   * @returns 内部 id。
   */
  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(12, "0")}`;
  }
}

/**
 * 去掉内部 content 字段，返回不含正文的版本记录。
 *
 * @param version 内部版本。
 * @returns 版本记录。
 */
function toVersionRecord(version: StoredVersion): RagDocumentVersionRecord {
  const { content: _content, ...record } = version;
  return {
    ...record,
    ...(record.error ? { error: { ...record.error } } : {}),
    ...(record.indexedAt !== undefined ? { indexedAt: record.indexedAt } : {})
  };
}

/**
 * 去掉内部 rowId 字段，返回 chunk 记录深拷贝。
 *
 * @param chunk 内部 chunk。
 * @returns chunk 记录。
 */
function toChunkRecord(chunk: StoredChunk): RagChunkRecord {
  const { rowId: _rowId, ...record } = chunk;
  return { ...record, metadata: { ...record.metadata } };
}

/**
 * 返回文档记录浅拷贝。
 *
 * @param document 文档记录。
 * @returns 拷贝后的文档记录。
 */
function cloneDocument(document: RagDocumentRecord): RagDocumentRecord {
  return { ...document };
}

/**
 * 编码文档分页 cursor：`createdAt|id`，id 作为同时间戳 tie-break。
 *
 * @param document 文档记录。
 * @returns cursor 字符串。
 */
function encodeDocumentCursor(document: RagDocumentRecord): string {
  return `${document.createdAt}|${document.id}`;
}

/**
 * 归一化分页 limit，缺省 50，上限 100。
 *
 * @param limit 调用方 limit。
 * @returns 合法 limit。
 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(limit, MAX_LIST_LIMIT);
}
