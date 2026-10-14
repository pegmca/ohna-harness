import {
  type EmbeddedChunk,
  type EmbeddingVector,
  type RagStructuredError,
  type VectorSearchResult,
  type VectorStoreResult
} from "./types.js";
import { cosineSimilarity, normalizeTopK } from "./vector-math.js";

/**
 * 会话级内联附件：解析文本长度 ≤ 阈值时，原文直接内联进 prompt，**不建向量索引**（§5.6 / D-P2-3）。
 *
 * 与向量索引（chunk + embedding）是两条独立通道：内联槽只存原文与展示元数据，
 * grounding hook 会把它合成为一条 score=1 的 synthetic RetrievedChunk 注入。
 * 不落主库（`document_versions.content NOT NULL` 约束见 §8.1），故原文仍存临时存储（Redis）。
 */
export interface InlineAttachment {
  /** 附件文档逻辑 id，与上传记录一致；内联合成 chunk 的 chunkId 即取该值。 */
  documentId: string;
  /** 解析后的完整原文。 */
  text: string;
  /** 逻辑来源标识，作为 citation.source 展示。 */
  source: string;
  /** 原始文件名，内联合成 chunk 的 source 展示名。 */
  fileName: string;
}

/**
 * 会话级附件存储抽象。
 *
 * 设计取舍（docs/v1.1/06-chat-attachments.md §5.4）：故意与 VectorStore "同形"——
 * 复用同一套 VectorStoreResult / VectorSearchResult 结果类型，便于依赖倒置与替换实现。
 * 生产用 Redis 实现（带 TTL 滑窗续期、会话隔离），测试用内存实现。
 *
 * 与 VectorStore 的差异在于**会话维度**：所有读写都以 conversationId 分桶，
 * 附件只能在同一会话内被检索，天然满足"会话级临时"隔离；TTL 由 touch 续期、
 * drop 主动回收（会话删除时）。
 *
 * 实现约束（round-trip 保真）：`upsert` 写入的 `EmbeddedChunk` 在 `search` 读回时
 * 必须保留 `source` 与 `embeddingModel` 等全部字段——citation 的 `source`
 * （见 answer.ts `createCitationFromRetrievedChunk`）直接取自 `chunk.source`，
 * grounding 注入文本也会展示它。若某实现（如 Redis）为了省空间只落部分字段，
 * 必须自行补齐，否则附件引用会退化为展示 documentId。
 */
export interface AttachmentStore {
  /**
   * 写入某会话某附件文档的 embedded chunks，同一 chunkId 覆盖。
   *
   * @param conversationId 会话 id；空白视为非法 scope。
   * @param documentId 附件文档逻辑 id；空白视为非法 scope。
   * @param chunks 已带 embedding 的 chunks。
   * @returns 写入数量、替换数量、当前会话索引规模和维度；维度或 scope 非法时返回结构化错误。
   */
  upsert(
    conversationId: string,
    documentId: string,
    chunks: readonly EmbeddedChunk[]
  ): Promise<VectorStoreResult>;

  /**
   * 在某会话内按 cosine similarity 检索 topK chunks。
   *
   * @param conversationId 会话 id；空白视为非法 scope。
   * @param queryVector 查询向量。
   * @param topK 期望召回数量；内部会做上限保护。
   * @returns 命中列表；空会话返回成功空数组，维度错误返回结构化错误。
   */
  search(
    conversationId: string,
    queryVector: EmbeddingVector,
    topK: number
  ): Promise<VectorSearchResult>;

  /**
   * 写入某会话某附件的内联原文槽（小附件走此路径，不建向量索引）。
   *
   * 与 upsert 的差异：内联槽以 documentId 为键直接存全文，同一 documentId 覆盖。
   * scope 非法（空 conversationId/documentId）时**静默 no-op**——内联是 best-effort 的
   * 优化路径，不引入结构化错误返回值（本方法返回 void），与 upsert 的结构化报错语义区分。
   *
   * @param conversationId 会话 id；空白视为非法 scope，直接忽略。
   * @param attachment 内联附件（documentId / 原文 / source / fileName）。
   * @returns 写入完成的 Promise。
   */
  putInline(conversationId: string, attachment: InlineAttachment): Promise<void>;

  /**
   * 读取某会话某附件的内联原文槽。
   *
   * @param conversationId 会话 id；空白或不存在时返回 null。
   * @param documentId 附件文档逻辑 id；空白或不存在时返回 null。
   * @returns 内联附件，缺失时返回 null。
   */
  getInline(conversationId: string, documentId: string): Promise<InlineAttachment | null>;

  /**
   * 滑窗续期该会话所有附件 key 的 TTL（内存实现为 no-op）。
   *
   * @param conversationId 会话 id。
   * @returns 续期完成的 Promise。
   */
  touch(conversationId: string): Promise<void>;

  /**
   * 主动回收该会话的全部附件（会话删除时调用；内存实现删除整桶，含内联槽）。
   *
   * @param conversationId 会话 id。
   * @returns 回收完成的 Promise。
   */
  drop(conversationId: string): Promise<void>;
}

/**
 * 创建内存附件存储。
 *
 * 仅适合单测、学习与本地 demo：不提供持久化、TTL 或跨进程共享。
 * 生产应替换为 Redis 实现（`createRedisAttachmentStore`），调用方代码无需改动。
 *
 * @param options 可选固定向量维度；不传时由第一次 upsert 的 chunk 推断。
 * @returns 实现 AttachmentStore 的内存附件存储。
 */
export function createInMemoryAttachmentStore(options: { dimensions?: number } = {}): AttachmentStore {
  return new InMemoryAttachmentStore(options.dimensions);
}

/**
 * 内存附件存储实现。
 *
 * 结构为 `Map<conversationId, Map<chunkId, EmbeddedChunk>>`：外层按会话分桶保证隔离，
 * 内层按 chunkId 替换写入，保持 upsert 行为与 InMemoryVectorStore 一致、可预测。
 * 维度在首次 upsert 时推断并固定，后续 query/chunk 维度不符一律结构化报错，避免脏向量。
 */
class InMemoryAttachmentStore implements AttachmentStore {
  private readonly chunksByConversation = new Map<string, Map<string, EmbeddedChunk>>();
  private readonly inlineByConversation = new Map<string, Map<string, InlineAttachment>>();
  private dimensions: number | undefined;

  /**
   * 创建内存附件存储实例。
   *
   * @param dimensions 可选固定向量维度；不传时由第一次 upsert 推断。
   */
  public constructor(dimensions?: number) {
    this.dimensions = dimensions;
  }

  /**
   * 写入某会话的 embedded chunks，相同 chunkId 会被替换。
   *
   * @param conversationId 会话 id。
   * @param documentId 附件文档逻辑 id。
   * @param chunks 已带 embedding 的 chunks。
   * @returns 写入数量、替换数量、该会话索引规模和维度；scope 或维度非法时返回结构化错误。
   */
  public async upsert(
    conversationId: string,
    documentId: string,
    chunks: readonly EmbeddedChunk[]
  ): Promise<VectorStoreResult> {
    const scopeError = validateAttachmentScope(conversationId, documentId);

    if (scopeError) {
      return { ok: false, error: scopeError };
    }

    const dimensionsResult = this.resolveUpsertDimensions(chunks);

    if (!dimensionsResult.ok) {
      return dimensionsResult;
    }

    let bucket = this.chunksByConversation.get(conversationId);

    if (!bucket) {
      bucket = new Map<string, EmbeddedChunk>();
      this.chunksByConversation.set(conversationId, bucket);
    }

    let replacedCount = 0;

    chunks.forEach((chunk) => {
      if (bucket.has(chunk.chunkId)) {
        replacedCount += 1;
      }

      bucket.set(chunk.chunkId, { ...chunk, embedding: [...chunk.embedding] });
    });

    return {
      ok: true,
      upsertedCount: chunks.length,
      replacedCount,
      totalCount: bucket.size,
      dimensions: dimensionsResult.dimensions
    };
  }

  /**
   * 在某会话内按 cosine similarity 检索 topK chunks。
   *
   * 单会话 chunk 量小，直接应用内暴力余弦即可（毫秒级），无需 RediSearch/Redis 向量集；
   * 量大时再升级实现，接口不变。
   *
   * @param conversationId 会话 id。
   * @param queryVector 查询向量。
   * @param topK 期望召回数量。
   * @returns 命中列表；空会话返回成功空数组，维度错误返回结构化错误。
   */
  public async search(
    conversationId: string,
    queryVector: EmbeddingVector,
    topK: number
  ): Promise<VectorSearchResult> {
    const scopeError = validateAttachmentScope(conversationId);

    if (scopeError) {
      return { ok: false, error: scopeError };
    }

    const topKResult = normalizeTopK(topK);

    if (!topKResult.ok) {
      return topKResult;
    }

    const bucket = this.chunksByConversation.get(conversationId);

    if (!bucket || bucket.size === 0) {
      return { ok: true, matches: [] };
    }

    if (this.dimensions !== undefined && queryVector.length !== this.dimensions) {
      return {
        ok: false,
        error: {
          code: "vector_store_dimension_mismatch",
          message: "query vector 维度与附件向量库维度不一致。",
          details: {
            expectedDimensions: this.dimensions,
            actualDimensions: queryVector.length
          }
        }
      };
    }

    const matches = [...bucket.values()]
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVector, chunk.embedding)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topKResult.topK)
      .map((match, index) => ({
        ...match,
        rank: index + 1
      }));

    return { ok: true, matches };
  }

  /**
   * 写入某会话的内联附件原文槽，同一 documentId 覆盖。
   *
   * 内联是"小附件直接进 prompt"的 best-effort 优化路径，方法返回 void；
   * scope 非法（空 conversationId/documentId）时**静默忽略**，不抛错、不写入，
   * 与 upsert 返回结构化错误的行为区分（对齐 §8.2 对内联槽的宽松契约）。
   *
   * @param conversationId 会话 id；空白时忽略。
   * @param attachment 内联附件（documentId / 原文 / source / fileName）。
   * @returns 写入完成的 Promise。
   */
  public async putInline(conversationId: string, attachment: InlineAttachment): Promise<void> {
    if (!isNonBlank(conversationId) || !isNonBlank(attachment.documentId)) {
      return;
    }

    let bucket = this.inlineByConversation.get(conversationId);

    if (!bucket) {
      bucket = new Map<string, InlineAttachment>();
      this.inlineByConversation.set(conversationId, bucket);
    }

    bucket.set(attachment.documentId, { ...attachment });
  }

  /**
   * 读取某会话的内联附件原文槽。
   *
   * @param conversationId 会话 id；空白视为缺失。
   * @param documentId 附件文档逻辑 id；空白视为缺失。
   * @returns 内联附件；缺失时返回 null。
   */
  public async getInline(conversationId: string, documentId: string): Promise<InlineAttachment | null> {
    if (!isNonBlank(conversationId) || !isNonBlank(documentId)) {
      return null;
    }

    const stored = this.inlineByConversation.get(conversationId)?.get(documentId);

    return stored ? { ...stored } : null;
  }

  /**
   * 内存实现没有 TTL，touch 为 no-op，仅满足接口契约。
   *
   * @param _conversationId 会话 id（内存实现忽略）。
   * @returns 立即完成的 Promise。
   */
  public async touch(_conversationId: string): Promise<void> {
    // 内存实现不维护 TTL，滑窗续期无操作。
  }

  /**
   * 删除该会话的整桶附件（向量索引桶 + 内联槽），等价于 Redis 实现的主动回收。
   *
   * @param conversationId 会话 id。
   * @returns 删除完成的 Promise。
   */
  public async drop(conversationId: string): Promise<void> {
    this.chunksByConversation.delete(conversationId);
    this.inlineByConversation.delete(conversationId);
  }

  /**
   * 校验 upsert chunks 的维度，并在首次写入时确定 store 维度。
   *
   * 与 InMemoryVectorStore 保持一致的错误形状（embedding_dimension_mismatch），
   * 让附件索引与主向量库在维度约束上行为统一。
   *
   * @param chunks 待写入 chunks。
   * @returns 合法时返回向量库维度，否则返回结构化错误。
   */
  private resolveUpsertDimensions(
    chunks: readonly EmbeddedChunk[]
  ): { ok: true; dimensions: number } | { ok: false; error: RagStructuredError } {
    if (chunks.length === 0) {
      return {
        ok: true,
        dimensions: this.dimensions ?? 0
      };
    }

    const firstDimensions = this.dimensions ?? chunks[0]?.embedding.length ?? 0;

    if (!Number.isInteger(firstDimensions) || firstDimensions <= 0) {
      return {
        ok: false,
        error: {
          code: "embedding_dimension_mismatch",
          message: "embedded chunk 必须包含非空向量。",
          details: {
            expectedDimensions: this.dimensions ?? null,
            actualDimensions: firstDimensions
          }
        }
      };
    }

    const mismatchedChunk = chunks.find((chunk) => chunk.embedding.length !== firstDimensions);

    if (mismatchedChunk) {
      return {
        ok: false,
        error: {
          code: "embedding_dimension_mismatch",
          message: "同一个附件向量库中的 chunk embedding 维度必须一致。",
          details: {
            chunkId: mismatchedChunk.chunkId,
            expectedDimensions: firstDimensions,
            actualDimensions: mismatchedChunk.embedding.length
          }
        }
      };
    }

    this.dimensions = firstDimensions;

    return {
      ok: true,
      dimensions: firstDimensions
    };
  }
}

/**
 * 校验附件写入/检索的会话与文档 scope。
 *
 * 附件是"会话级临时"资源，会话 id 是强隔离键；空会话会让不同会话的附件互串，
 * 空 documentId 会让 chunk 归属不可追溯，因此在入口处直接拒绝并返回结构化错误。
 *
 * @param conversationId 会话 id。
 * @param documentId 可选附件文档逻辑 id；检索场景只需校验会话。
 * @returns 合法时返回 undefined，否则返回 invalid_attachment_scope 结构化错误。
 */
function validateAttachmentScope(conversationId: string, documentId?: string): RagStructuredError | undefined {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    return {
      code: "invalid_attachment_scope",
      message: "附件操作必须携带非空 conversationId。",
      details: { reason: "missing_conversation_id" }
    };
  }

  if (documentId !== undefined && documentId.trim().length === 0) {
    return {
      code: "invalid_attachment_scope",
      message: "附件写入必须携带非空 documentId。",
      details: { reason: "missing_document_id" }
    };
  }

  return undefined;
}

/**
 * 判断字符串是否为非空（去空白后长度 > 0）。
 *
 * 内联槽的 put/get 需要宽松的 scope 判定：非法 scope 返回 null / no-op 而非结构化错误，
 * 故单独抽出该谓词，避免与返回 RagStructuredError 的 validateAttachmentScope 混用。
 *
 * @param value 待判定字符串。
 * @returns 非空返回 true。
 */
function isNonBlank(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
