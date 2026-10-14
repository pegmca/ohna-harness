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
 * 内联阈值缺省值（字符数）：解析文本 ≤ 该值时走"原文内联"，不建向量索引。
 *
 * 参考 Anthropic "知识库 < 200k token 时整库内联 + prompt caching 更快更省"的经验，
 * 这里用字符数近似（默认 200_000 字符）。生产可由 env（AIAGENT_ATTACHMENT_INLINE_MAX_CHARS）覆盖。
 */
export const DEFAULT_ATTACHMENT_INLINE_MAX_CHARS = 200_000;

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
  /**
   * 内联阈值（字符数）：解析文本长度 ≤ 该值 → 原文内联；否则切块 + embed + upsert。
   * 缺省 DEFAULT_ATTACHMENT_INLINE_MAX_CHARS。
   */
  inlineMaxChars?: number;
}

/**
 * ingestChatAttachment 的成功结果（判别联合，按 mode 区分路由）。
 *
 * - `mode: "inline"`：小附件走原文内联，`chunks=[]`、`indexedChunkCount=0`（未建索引）；
 * - `mode: "indexed"`：大附件走切块 + embed + upsert，返回 chunks 与入库数量。
 *
 * 两种成功形态都保留 chunks/indexedChunkCount 字段，便于调用方按 mode 分支但无需区分字段存在性。
 */
export type IngestChatAttachmentResult =
  | {
      ok: true;
      mode: "inline";
      chunks: RagChunk[];
      indexedChunkCount: number;
    }
  | {
      ok: true;
      mode: "indexed";
      chunks: RagChunk[];
      indexedChunkCount: number;
    }
  | {
      ok: false;
      error: RagStructuredError;
    };

/**
 * 将聊天附件解析后按阈值路由：小文件原文内联，大文件切块 + embedding 写入会话级 AttachmentStore。
 *
 * 流程（§8.2 D-P2-3）：
 * 1. 解析（ingestDocument）；失败 → `ingestion_failed`（保留 parsing 原始错误码在 details）。
 * 2. 计算解析全文 `blocks.map(b => b.text).join("\n\n")`。
 * 3. 长度 ≤ 阈值 → `attachmentStore.putInline(...)` → 返回 `mode:"inline"`（跳过 chunk/embed/upsert）。
 * 4. 否则走原路径：chunk → embed → upsert → 返回 `mode:"indexed"`；
 *    切块失败透传 chunking 错误，embedding 失败透传 embedding 错误，upsert 失败 → `attachment_store_failed`。
 *
 * documentId 始终沿用调用方传入值：解析器会基于内容生成稳定 id，但附件 id 必须与
 * 上传记录一致，故这里显式覆盖，保证 chunkId（`${documentId}_chunk_0000`）与记录对齐。
 *
 * @param input embedding client、附件存储、会话/文档标识、附件内容与可选内联阈值。
 * @returns 成功时按 mode 返回 chunks 与入库数量，失败时返回结构化 RAG 错误。
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
  const parsedText = document.blocks.map((block) => block.text).join("\n\n");
  const inlineMaxChars = input.inlineMaxChars ?? DEFAULT_ATTACHMENT_INLINE_MAX_CHARS;

  // 阈值路由：小附件原文内联（不建索引），大附件才切块 + embed + upsert。
  if (parsedText.length <= inlineMaxChars) {
    try {
      await input.attachmentStore.putInline(input.conversationId, {
        documentId: input.documentId,
        text: parsedText,
        source: input.source,
        fileName: input.fileName
      });
    } catch (storeError) {
      return {
        ok: false,
        error: {
          code: "attachment_store_failed",
          message: storeError instanceof Error ? storeError.message : "内联附件写入失败。",
          details: {
            storeCode: storeError instanceof Error ? storeError.name : "unknown",
            mode: "inline"
          }
        }
      };
    }

    return {
      ok: true,
      mode: "inline",
      chunks: [],
      indexedChunkCount: 0
    };
  }

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
    mode: "indexed",
    chunks,
    indexedChunkCount: embeddedChunks.length
  };
}
