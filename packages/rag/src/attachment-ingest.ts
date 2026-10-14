import { ingestDocument } from "@aiagent/parsing";
import type { AttachmentStore } from "./attachment-store.js";
import { chunkIngestedDocument } from "./chunking.js";
import type {
  EmbeddedChunk,
  EmbeddingClient,
  RagChunk,
  RagStructuredError
} from "./types.js";

/**
 * 聊天附件 ingest 入参。
 *
 * 与持久化 RAG 的 DataSourceIngestRequestDto 的关键差异：附件按**会话**隔离，
 * 因此 conversationId 必填，documentId 由上传流程（API 层 randomUUID）生成并传入，
 * 而不是在解析时重新推导——这样上传记录、Redis 附件索引、后续 citation 共用同一逻辑 id。
 */
export interface IngestChatAttachmentInput {
  /** embedding provider 边界；生产注入真实 client，测试注入 deterministic 替身。 */
  embeddingClient: EmbeddingClient;
  /** 会话级附件存储。 */
  attachmentStore: AttachmentStore;
  /** 会话 id；附件只在同一会话内可检索。 */
  conversationId: string;
  /** 附件文档逻辑 id，由调用方给定（不重新推导）。 */
  documentId: string;
  /** 逻辑来源标识，写入 chunk.source 供 citation 展示。 */
  source: string;
  /** 原始文件名，用于类型检测与标题推导。 */
  fileName: string;
  /** content-type，可选；缺省时仅按扩展名检测。 */
  contentType?: string;
  /** 附件正文文本。 */
  content: string;
}

/** ingestChatAttachment 的成功结果：chunks 用于回写上传记录/审计，indexedChunkCount 为实际入库数。 */
export type IngestChatAttachmentResult =
  | {
      ok: true;
      chunks: RagChunk[];
      indexedChunkCount: number;
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

/**
 * 将聊天附件解析、切块、embedding 后写入会话级 AttachmentStore（不落主库）。
 *
 * 流程与 DataSourceRuntime.ingest 的解析→切块→embed→upsert 序列一致，
 * 但去掉 lineage 持久化，改为写入按会话分桶的临时附件存储：
 * - 解析失败 → `ingestion_failed`（保留 parsing 原始错误码在 details）；
 * - 切块失败 → 原样透传 chunking 结构化错误；
 * - embedding 失败 → 原样透传 embedding 结构化错误；
 * - upsert 失败 → `attachment_store_failed`（保留 store 原始错误码在 details）。
 *
 * documentId 始终沿用调用方传入值：解析器会基于内容生成稳定 id，但附件 id 必须与
 * 上传记录一致，故这里显式覆盖，保证 chunkId（`${documentId}_chunk_0000`）与记录对齐。
 *
 * @param input embedding client、附件存储、会话/文档标识与附件内容。
 * @returns 成功时返回 chunks 与入库数量，失败时返回结构化 RAG 错误。
 */
export async function ingestChatAttachment(
  input: IngestChatAttachmentInput
): Promise<IngestChatAttachmentResult> {
  const ingestionResult = ingestDocument({
    source: input.source,
    fileName: input.fileName,
    contentType: input.contentType,
    content: input.content
  });

  if (!ingestionResult.ok) {
    return {
      ok: false,
      error: {
        code: "ingestion_failed",
        message: ingestionResult.error.message,
        details: {
          parsingCode: ingestionResult.error.code,
          ...ingestionResult.error.details
        }
      }
    };
  }

  // 覆盖解析器生成的 documentId，沿用调用方给定的附件 id，保证 chunkId 与上传记录一致。
  const document = { ...ingestionResult.document, documentId: input.documentId };
  const chunkingResult = chunkIngestedDocument(document);

  if (!chunkingResult.ok) {
    return { ok: false, error: chunkingResult.error };
  }

  const chunks = chunkingResult.chunks;
  const embeddingResult = await input.embeddingClient.embedTexts(chunks.map((chunk) => chunk.text));

  if (!embeddingResult.ok) {
    return { ok: false, error: embeddingResult.error };
  }

  const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddingResult.embeddings[index].vector,
    embeddingModel: embeddingResult.model
  }));
  const upsertResult = await input.attachmentStore.upsert(
    input.conversationId,
    input.documentId,
    embeddedChunks
  );

  if (!upsertResult.ok) {
    return {
      ok: false,
      error: {
        code: "attachment_store_failed",
        message: upsertResult.error.message,
        details: {
          storeCode: upsertResult.error.code,
          ...upsertResult.error.details
        }
      }
    };
  }

  return {
    ok: true,
    chunks,
    indexedChunkCount: embeddedChunks.length
  };
}
