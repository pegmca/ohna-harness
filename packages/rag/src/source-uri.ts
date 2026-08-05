import { createHash } from "node:crypto";
import type { RetrievalTraceDto } from "@aiagent/types";
import type {
  NewRagChunkRecord,
  RagChunkRecord,
  RagDocumentSourceType
} from "./document-repository.js";
import { createQueryPreview } from "./retrieval.js";
import type { HybridRetrievalResult, RagChunk } from "./types.js";

/**
 * 校验 ingest source 是否符合写入口安全边界。
 *
 * 拒绝：绝对路径（`/`、`~` 开头）、Windows 盘符（`C:`）、`file:` URI、包含 `..` 的
 * 路径段、控制字符、反斜杠，以及带 userinfo（`user@`/`user:pass@`）的 http(s) URL；
 * 允许：合法的 http(s) URL，以及由字母数字和 `-_.:/` 组成的相对逻辑标识
 * （如 `demo/annual-report`、`mock://filings/x.md`）。
 * API 层与 runtime 共用同一校验，保证 sourceUri 落库前已被白名单过滤，
 * 因此列表 DTO 中的 sourceUri 不需要额外脱敏。
 *
 * @param source ingest 请求的 source。
 * @returns 符合安全边界返回 true。
 */
export function isSafeRagSourceUri(source: string): boolean {
  const value = source.trim();
  if (value.length === 0 || value.length > 512) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      // userinfo 是凭证载体，一律拒绝，避免账号密码进入 lineage 和共享列表。
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }
  if (/[\x00-\x1f]/.test(value)) {
    return false;
  }
  if (value.includes("\\")) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("~")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  if (/^file:/i.test(value)) {
    return false;
  }
  if (value.split("/").includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9\-_.:/]+$/.test(value);
}

/**
 * source URI query 安全资源标识 allowlist（大小写不敏感匹配）。
 *
 * 只有这些显式声明的非敏感标识键会保留在 canonical sourceUri 中并参与 lineage 区分；
 * 未列入的合法标识参数不参与区分，需要时扩充本集合。
 */
export const SAFE_SOURCE_QUERY_KEYS = new Set([
  "id",
  "doc",
  "document",
  "file",
  "name",
  "page",
  "v",
  "version",
  "ticker",
  "year",
  "quarter",
  "type",
  "format",
  "lang",
  "locale",
  "region",
  "category"
]);

/**
 * 规范化 ingest source 为可持久化的 canonical sourceUri。
 *
 * 该函数同时服务两个目标：
 * - 脱敏：未知参数默认不可信。fragment 一律剥离；query 只保留 allowlist
 *   （`SAFE_SOURCE_QUERY_KEYS`，大小写不敏感）中的资源标识键，其余键——无论是否长得像
 *   凭证（token、accessToken、client_secret、AWSAccessKeyId……）——一律删除，
 *   任何未声明的参数都不会进入 lineage，也不会出现在 shared/demo 列表 DTO 中。
 * - 资源 identity：allowlist 内的参数（如 `?id=filing-A`）按键名（同键按值）排序后保留，
 *   这样 `?id=A` 与 `?id=B` 是不同逻辑文档，而同一资源带不带凭证参数都命中同一 externalId。
 *   tradeoff：未列入 allowlist 的合法标识参数不参与区分 lineage，需要时扩充常量集合。
 *
 * http(s) URL 返回 `origin + pathname + 规范化 query`；非 URL 逻辑标识已通过
 * `isSafeRagSourceUri` 白名单，原样返回。
 *
 * @param source 已通过安全校验的 source。
 * @returns 脱敏且保留资源标识参数的 canonical sourceUri。
 */
export function normalizeRagSourceUri(source: string): string {
  const value = source.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const kept = [...url.searchParams.entries()]
        .filter(([key]) => SAFE_SOURCE_QUERY_KEYS.has(key.toLowerCase()))
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
        );
      const query = kept.map(([key, entryValue]) => `${encodeURIComponent(key)}=${encodeURIComponent(entryValue)}`).join("&");
      return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * 计算 ingestion lineage 使用的 SHA-256 校验和（hex）。
 *
 * @param value 待哈希文本。
 * @returns SHA-256 hex 字符串。
 */
export function createRagContentChecksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 从 ingest source URI 推导文档来源类型。
 *
 * http(s) 视为远程地址，mock/demo 前缀视为演示文本，其余按本地文件处理；
 * 这只是 lineage 分类，不放宽 API 层已有的 ingestion 安全边界。
 *
 * @param source ingest 请求的 source。
 * @returns 文档来源类型。
 */
export function resolveRagSourceType(source: string): RagDocumentSourceType {
  if (/^https?:\/\//i.test(source)) {
    return "remote_url";
  }
  if (/^(mock|demo)(:|\/|$)/i.test(source)) {
    return "mock_text";
  }
  return "local_file";
}

/**
 * 把 chunker 输出的 RagChunk 映射为待持久化 chunk 记录。
 *
 * charStart/charEnd/startOffset/endOffset 没有独立列，统一并入 metadata JSONB，
 * 读回时可还原出与 chunker 输出完全一致的 RagChunkDto 形状。
 *
 * @param chunk chunker 输出 chunk。
 * @returns 待持久化 chunk 记录。
 */
export function toNewChunkRecord(chunk: RagChunk): NewRagChunkRecord {
  const lineStart = readMetadataNumber(chunk.metadata, "lineStart");
  const lineEnd = readMetadataNumber(chunk.metadata, "lineEnd");
  const pageNumber = chunk.pageNumber ?? chunk.page;

  return {
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    metadata: {
      ...chunk.metadata,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset
    },
    contentChecksum: createRagContentChecksum(chunk.text)
  };
}

/**
 * 把持久化 chunk 记录重建为 RagChunkDto，偏移字段从 metadata JSONB 还原。
 *
 * @param record 持久化 chunk 记录。
 * @returns 与 chunker 输出形状一致的 RagChunkDto。
 */
export function ragChunkRecordToChunk(record: RagChunkRecord): RagChunk {
  const charStart = readMetadataNumber(record.metadata, "charStart") ?? 0;
  const charEnd = readMetadataNumber(record.metadata, "charEnd") ?? record.text.length;

  return {
    chunkId: record.chunkId,
    id: record.chunkId,
    documentId: record.documentId,
    source: record.source,
    chunkIndex: record.chunkIndex,
    text: record.text,
    charStart,
    charEnd,
    startOffset: readMetadataNumber(record.metadata, "startOffset") ?? charStart,
    endOffset: readMetadataNumber(record.metadata, "endOffset") ?? charEnd,
    ...(record.pageNumber !== undefined ? { page: record.pageNumber, pageNumber: record.pageNumber } : {}),
    ...(record.heading !== undefined ? { heading: record.heading } : {}),
    metadata: { ...record.metadata }
  };
}

/**
 * 从 chunk metadata 读取数值字段，非数值一律视为缺失。
 *
 * @param metadata chunk metadata。
 * @param key 字段名。
 * @returns 数值或 undefined。
 */
export function readMetadataNumber(metadata: Record<string, string | number | boolean | null>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * 创建可返回 API/UI 的 retrieval trace event。
 *
 * @param query 原始问题或搜索词。
 * @param result 检索结果。
 * @returns trace retrieval event DTO。
 */
export function createTraceRetrievalEvent(
  query: string,
  result: HybridRetrievalResult
): RetrievalTraceDto {
  const now = new Date().toISOString();

  return {
    type: "retrieval",
    id: `retrieval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    traceId: "rag_runtime_trace",
    requestId: "rag_runtime_request",
    createdAt: now,
    queryPreview: result.trace.queryPreview || createQueryPreview(query),
    mode: result.trace.mode,
    topK: result.trace.topK,
    candidateLimit: result.trace.candidateLimit,
    durationMs: result.trace.durationMs,
    chunkIds: result.trace.chunkIds,
    scoreSummary: result.trace.scoreSummary,
    ok: result.ok,
    error: result.ok
      ? undefined
      : {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details
        }
  };
}
