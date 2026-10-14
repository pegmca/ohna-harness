import { RESP_TYPES, createClient, type RedisClientType } from "redis";
import {
  cosineSimilarity,
  createInMemoryAttachmentStore,
  normalizeTopK,
  type AttachmentStore,
  type EmbeddedChunk,
  type EmbeddingVector,
  type InlineAttachment,
  type RagStructuredError,
  type VectorSearchMatch,
  type VectorSearchResult,
  type VectorStoreResult
} from "@aiagent/rag";

/** 附件临时索引的缺省 TTL：7 天，对齐 OpenAI 会话附件的过期语义（§5.3）。 */
export const DEFAULT_ATTACHMENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 覆盖默认 TTL 的环境变量名。 */
export const ATTACHMENT_TTL_ENV = "AIAGENT_ATTACHMENT_TTL_SECONDS";

/**
 * 读回 chunk 时用于补齐 embeddingModel 的稳定标记。
 *
 * §5.3 的 key schema 持久化 conversationId/documentId/source/chunkIndex/text/heading/
 * pageNumber/lineStart/lineEnd/embedding，但不含 embeddingModel；EmbeddedChunk 合同要求该字段，
 * 且附件路检索不按模型过滤，故读回时用这个确定性常量补齐（不参与任何检索语义）。
 */
const ATTACHMENT_EMBEDDING_MODEL = "attachment-redis";

/** Redis AttachmentStore 的构造选项。 */
export interface RedisAttachmentStoreOptions {
  /** 官方 node-redis v4+ 客户端；store 只使用其 hash/set/TTL 命令。 */
  client: RedisClientType;
  /** 附件 key 的 TTL 秒数；缺省 7 天（DEFAULT_ATTACHMENT_TTL_SECONDS）。 */
  ttlSeconds?: number;
  /**
   * 可选连接钩子：store 在每条命令前 await 它一次。
   *
   * 组合根在模块顶层同步构建 app，无法 await `client.connect()`；env 工厂把"首次连接"
   * 收敛为单个共享 promise 后通过该钩子注入，store 本身对连接生命周期无感知。
   * 不传时假定 client 已连接（显式管理连接的测试或长驻进程）。
   */
  connect?: () => Promise<void>;
}

/**
 * 创建 Redis 支撑的 AttachmentStore 适配器（会话级临时附件索引）。
 *
 * key schema 与 TTL 严格对齐 `docs/v1.1/06-chat-attachments.md` §5.3：
 * - `attach:conv:{convId}:docs` 保存该会话的 docId 集合（会话锚点，用于枚举/续期/回收）；
 * - `attach:conv:{convId}:doc:{docId}` 保存 doc 级元数据（chunkCount/createdAt）；
 * - `attach:conv:{convId}:doc:{docId}:chunk:{index}` 保存单个 chunk，embedding 用 FLOAT32 原始字节。
 *
 * 检索走应用内暴力余弦（裸 Redis 即可，单会话 chunk 量小），不依赖 RediSearch。
 *
 * @param options 客户端、TTL 与可选连接钩子。
 * @returns 实现 AttachmentStore 端口的 Redis adapter。
 */
export function createRedisAttachmentStore(options: RedisAttachmentStoreOptions): AttachmentStore {
  return new RedisAttachmentStore(options);
}

/**
 * 按环境变量选择 AttachmentStore 实现，作为 composition root 的注入边界。
 *
 * 存在 `REDIS_URL` → 走 Redis（懒连接：首次命令前共享一次 `connect()`）；
 * 未配置 → 退化为内存实现（单测/本地 demo，无跨进程共享与 TTL）。
 *
 * 该函数**同步返回**：组合根在模块顶层构建 app，不能在此 await 连接。
 *
 * @returns 附件 store 与关闭函数；close 仅在已连接时 quit。
 */
export function createAttachmentStoreFromEnv(): { store: AttachmentStore; close: () => Promise<void> } {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return { store: createInMemoryAttachmentStore(), close: async () => {} };
  }
  const client = createClient({ url: redisUrl });
  // 懒连接：把首次 connect() 收敛为单个共享 promise；失败时清空以允许后续重试。
  let connectPromise: Promise<unknown> | undefined;
  const ensureConnected = async (): Promise<void> => {
    if (client.isReady) return;
    if (!connectPromise) {
      connectPromise = client.connect().catch((error: unknown) => {
        connectPromise = undefined;
        throw error;
      });
    }
    await connectPromise;
  };
  const store = createRedisAttachmentStore({
    client,
    ttlSeconds: readAttachmentTtlSeconds(),
    connect: ensureConnected
  });
  return {
    store,
    async close() {
      if (client.isOpen) await client.quit();
    }
  };
}

/** 应用 BLOB_STRING→Buffer type mapping 后的客户端类型，仅用于以二进制读回 chunk hash。 */
type BufferedRedisClient = ReturnType<RedisClientType["withTypeMapping"]>;

/** Redis AttachmentStore 的具体实现。 */
class RedisAttachmentStore implements AttachmentStore {
  private readonly client: RedisClientType;
  private readonly buffered: BufferedRedisClient;
  private readonly ttlSeconds: number;
  private readonly connect: () => Promise<void>;

  /**
   * @param options 已解析的构造选项。
   */
  public constructor(options: RedisAttachmentStoreOptions) {
    this.client = options.client;
    // RESP3 的 blob string 默认解码为 UTF-8 字符串，会破坏二进制 embedding；
    // 这里用 type mapping 让 blob string 以 Buffer 返回，仅用于读取 chunk hash。
    this.buffered = options.client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_ATTACHMENT_TTL_SECONDS;
    this.connect = options.connect ?? (async () => {});
  }

  /**
   * 幂等写入某会话某附件的 chunks，并对该会话的全部 key 刷新 TTL。
   *
   * @param conversationId 会话标识；空或纯空白返回 invalid_attachment_scope。
   * @param documentId 附件逻辑文档标识（Redis 中的 docId）；空或纯空白返回 invalid_attachment_scope。
   * @param chunks 已生成 embedding 的 chunks。
   * @returns 写入/替换数量、会话内 chunk 总数与维度；Redis 故障返回 attachment_store_failed。
   */
  public async upsert(
    conversationId: string,
    documentId: string,
    chunks: readonly EmbeddedChunk[]
  ): Promise<VectorStoreResult> {
    if (isBlank(conversationId) || isBlank(documentId)) {
      return invalidScope();
    }
    const dimensions = chunks[0]?.embedding.length ?? 0;
    const embeddingError = validateEmbeddings(chunks, dimensions);
    if (embeddingError) return { ok: false, error: embeddingError };
    try {
      await this.connect();
      const docsKey = conversationDocsKey(conversationId);
      const docKey = conversationDocKey(conversationId, documentId);
      // 读取旧 chunkCount，用于覆盖时清理多余的历史 chunk key（重传后 chunk 数可能变少）。
      const previousCount = Number((await this.client.hGet(docKey, "chunkCount")) ?? 0);

      const multi = this.client.multi();
      multi.hSet(docKey, { chunkCount: String(chunks.length), createdAt: new Date().toISOString() });
      chunks.forEach((chunk, index) => {
        const chunkKey = conversationChunkKey(conversationId, documentId, index);
        // lineStart/lineEnd 由 chunking 写入 metadata；pageNumber 优先取 chunk 顶层字段。
        const lineStart = metadataNumber(chunk.metadata, "lineStart");
        const lineEnd = metadataNumber(chunk.metadata, "lineEnd");
        const pageNumber = chunk.pageNumber ?? metadataNumber(chunk.metadata, "pageNumber");
        multi.hSet(chunkKey, {
          conversationId,
          documentId,
          source: chunk.source,
          chunkIndex: String(index),
          text: chunk.text,
          heading: chunk.heading ?? "",
          pageNumber: pageNumber !== undefined ? String(pageNumber) : "",
          lineStart: lineStart !== undefined ? String(lineStart) : "",
          lineEnd: lineEnd !== undefined ? String(lineEnd) : "",
          embedding: encodeEmbedding(chunk.embedding)
        });
        multi.expire(chunkKey, this.ttlSeconds);
      });
      for (let index = chunks.length; index < previousCount; index += 1) {
        multi.del(conversationChunkKey(conversationId, documentId, index));
      }
      multi.sAdd(docsKey, documentId);
      multi.expire(docKey, this.ttlSeconds);
      multi.expire(docsKey, this.ttlSeconds);
      await multi.execAsPipeline();

      return {
        ok: true,
        upsertedCount: chunks.length,
        replacedCount: previousCount > 0 ? chunks.length : 0,
        totalCount: await this.countChunks(conversationId),
        dimensions
      };
    } catch {
      return storeFailure();
    }
  }

  /**
   * 在会话范围内做暴力余弦 topK 检索。
   *
   * @param conversationId 会话标识；空或纯空白返回 invalid_attachment_scope。
   * @param queryVector 查询向量；维度与已存 chunk 不一致返回 vector_store_dimension_mismatch。
   * @param topK 期望召回数量；由 normalizeTopK 校验并上限截断。
   * @returns 稳定排序的 matches（score 降序、rank 从 1 起）；空会话为成功空数组；Redis 故障返回 attachment_store_failed。
   */
  public async search(
    conversationId: string,
    queryVector: EmbeddingVector,
    topK: number
  ): Promise<VectorSearchResult> {
    if (isBlank(conversationId)) {
      return invalidScope();
    }
    const topKResult = normalizeTopK(topK);
    if (!topKResult.ok) {
      return topKResult;
    }
    try {
      await this.connect();
      const docIds = await this.client.sMembers(conversationDocsKey(conversationId));
      if (docIds.length === 0) {
        return { ok: true, matches: [] };
      }
      const chunks: EmbeddedChunk[] = [];
      for (const documentId of docIds) {
        const chunkCount = Number((await this.client.hGet(conversationDocKey(conversationId, documentId), "chunkCount")) ?? 0);
        for (let index = 0; index < chunkCount; index += 1) {
          const hash = await this.buffered.hGetAll(
            conversationChunkKey(conversationId, documentId, index)
          );
          if (!hash || Object.keys(hash).length === 0) continue;
          const chunk = buildChunk(hash, conversationId, documentId, index);
          if (chunk.embedding.length > 0) chunks.push(chunk);
        }
      }
      if (chunks.length === 0) {
        return { ok: true, matches: [] };
      }
      // 与内存实现保持一致的维度校验：query 维度必须等于已存 chunk 的维度，避免脏向量静默返回 0 分。
      const storeDimensions = chunks[0].embedding.length;
      if (queryVector.length !== storeDimensions) {
        return {
          ok: false,
          error: {
            code: "vector_store_dimension_mismatch",
            message: "query vector 维度与附件向量库维度不一致。",
            details: { expectedDimensions: storeDimensions, actualDimensions: queryVector.length }
          }
        };
      }
      const matches: VectorSearchMatch[] = chunks
        .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.embedding) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, topKResult.topK)
        .map((match, index) => ({ chunk: match.chunk, score: match.score, rank: index + 1 }));
      return { ok: true, matches };
    } catch {
      return storeFailure();
    }
  }

  /**
   * 刷新该会话全部 key 的 TTL（滑窗续期），使活跃会话的附件持续有效。
   *
   * @param conversationId 会话标识。
   * @returns 无返回值；Redis 故障抛出已脱敏的错误，避免泄漏驱动细节。
   */
  public async touch(conversationId: string): Promise<void> {
    if (isBlank(conversationId)) return;
    try {
      await this.connect();
      const keys = await this.collectKeys(conversationId);
      if (keys.length === 0) return;
      const multi = this.client.multi();
      for (const key of keys) multi.expire(key, this.ttlSeconds);
      await multi.execAsPipeline();
    } catch {
      throw new Error("attachment_store_failed");
    }
  }

  /**
   * 主动回收该会话的全部附件 key（会话删除时调用）。
   *
   * @param conversationId 会话标识。
   * @returns 无返回值；Redis 故障抛出已脱敏的错误。
   */
  public async drop(conversationId: string): Promise<void> {
    if (isBlank(conversationId)) return;
    try {
      await this.connect();
      const keys = await this.collectKeys(conversationId);
      if (keys.length === 0) return;
      await this.client.del(keys);
    } catch {
      throw new Error("attachment_store_failed");
    }
  }

  /**
   * 写入某会话某附件的内联原文槽（小附件走此路径，不建向量索引）。
   *
   * P2-B（§8.2 row C）：内联槽以 `attach:conv:{convId}:doc:{docId}:inline` 为键，
   * 值为 JSON string `{ text, source, fileName }`。写入时同时 `sAdd(docsKey, documentId)`
   * 使 docs SET 成为统一的会话锚点，`collectKeys` / `touch` / `drop` 据此覆盖内联键。
   *
   * scope 非法（空 conversationId/documentId）时**静默 no-op**——内联是 best-effort 的
   * 优化路径，方法返回 void，与 upsert 的结构化报错语义区分。Redis 故障时异常直接传播，
   * 由调用方（`ingestChatAttachment`）的 try/catch 封装为 `attachment_store_failed`。
   *
   * @param conversationId 会话标识；空白时忽略。
   * @param attachment 内联附件（documentId / 原文 / source / fileName）。
   * @returns 写入完成的 Promise。
   */
  public async putInline(conversationId: string, attachment: InlineAttachment): Promise<void> {
    if (isBlank(conversationId) || isBlank(attachment.documentId)) return;
    try {
      await this.connect();
      const inlineKey = conversationInlineKey(conversationId, attachment.documentId);
      const docsKey = conversationDocsKey(conversationId);
      const jsonString = JSON.stringify({
        text: attachment.text,
        source: attachment.source,
        fileName: attachment.fileName
      });
      await this.client.set(inlineKey, jsonString);
      await this.client.sAdd(docsKey, attachment.documentId);
      await this.client.expire(inlineKey, this.ttlSeconds);
      await this.client.expire(docsKey, this.ttlSeconds);
    } catch {
      // Redis 故障：异常传播给调用方，由 ingestChatAttachment 的 try/catch 封装为结构化错误。
      throw new Error("attachment_store_failed");
    }
  }

  /**
   * 读取某会话某附件的内联原文槽。
   *
   * P2-B（§8.2 row C）：从 `attach:conv:{convId}:doc:{docId}:inline` 读取 JSON string，
   * 解析为 `{ text, source, fileName }` 并补齐 documentId 后返回。缺失或解析失败返回 null。
   *
   * @param conversationId 会话标识；空白或不存在时返回 null。
   * @param documentId 附件文档逻辑 id；空白或不存在时返回 null。
   * @returns 内联附件；缺失时返回 null。
   */
  public async getInline(conversationId: string, documentId: string): Promise<InlineAttachment | null> {
    if (isBlank(conversationId) || isBlank(documentId)) return null;
    try {
      await this.connect();
      const raw = await this.client.get(conversationInlineKey(conversationId, documentId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { text?: string; source?: string; fileName?: string };
      if (typeof parsed.text !== "string" || typeof parsed.source !== "string" || typeof parsed.fileName !== "string") {
        return null;
      }
      return { documentId, text: parsed.text, source: parsed.source, fileName: parsed.fileName };
    } catch {
      // JSON 解析失败或 Redis 故障：best-effort 返回 null。
      return null;
    }
  }

  /**
   * 枚举会话内全部附件 key（docs 集合 + 每个 doc hash + 每个 chunk key + 每个 inline key）。
   *
   * P2-B 新增：对每个 docId 额外收集 `attach:conv:{convId}:doc:{docId}:inline` 键，
   * 使 `touch` / `drop` 一并覆盖内联槽（§8.2 row C）。
   *
   * @param conversationId 会话标识。
   * @returns 该会话的全部 Redis key。
   */
  private async collectKeys(conversationId: string): Promise<string[]> {
    const docsKey = conversationDocsKey(conversationId);
    const docIds = await this.client.sMembers(docsKey);
    const keys: string[] = [docsKey];
    for (const documentId of docIds) {
      keys.push(conversationDocKey(conversationId, documentId));
      const chunkCount = Number((await this.client.hGet(conversationDocKey(conversationId, documentId), "chunkCount")) ?? 0);
      for (let index = 0; index < chunkCount; index += 1) {
        keys.push(conversationChunkKey(conversationId, documentId, index));
      }
      // 内联槽 key：可能不存在（大文件走向量索引路），但加入列表后 touch/drop 会安全地忽略缺失键。
      keys.push(conversationInlineKey(conversationId, documentId));
    }
    return keys;
  }

  /**
   * 统计会话内已写入的 chunk 总数。
   *
   * @param conversationId 会话标识。
   * @returns chunk 总数。
   */
  private async countChunks(conversationId: string): Promise<number> {
    const docIds = await this.client.sMembers(conversationDocsKey(conversationId));
    let total = 0;
    for (const documentId of docIds) {
      total += Number((await this.client.hGet(conversationDocKey(conversationId, documentId), "chunkCount")) ?? 0);
    }
    return total;
  }
}

/**
 * 读取附件 TTL 秒数。
 *
 * @returns 环境变量提供的正整数秒数；缺省、非数字或非正数时回退 7 天。
 */
function readAttachmentTtlSeconds(): number {
  const raw = process.env[ATTACHMENT_TTL_ENV]?.trim();
  if (!raw) return DEFAULT_ATTACHMENT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ATTACHMENT_TTL_SECONDS;
  return Math.floor(parsed);
}

/**
 * 校验 chunks 的 embedding 维度一致且为有限数值。
 *
 * @param chunks 待写入 chunks。
 * @param dimensions 期望维度（首个 chunk 的向量长度）。
 * @returns 首个结构化错误；合法时返回 undefined。
 */
function validateEmbeddings(chunks: readonly EmbeddedChunk[], dimensions: number): RagStructuredError | undefined {
  if (chunks.length === 0) return undefined;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return {
      code: "embedding_dimension_mismatch",
      message: "embedded chunk 必须包含非空向量。",
      details: { actualDimensions: dimensions }
    };
  }
  const invalid = chunks.find(
    (chunk) => chunk.embedding.length !== dimensions || chunk.embedding.some((value) => !Number.isFinite(value))
  );
  if (!invalid) return undefined;
  return {
    code: "embedding_dimension_mismatch",
    message: "同一会话的 chunk embedding 维度必须一致且仅包含有限数值。",
    details: { expectedDimensions: dimensions, actualDimensions: invalid.embedding.length, chunkId: invalid.chunkId }
  };
}

/**
 * 将 embedding 编码为 FLOAT32 原始字节（而非 JSON 数组，省内存）。
 *
 * @param vector 数值向量。
 * @returns 小端/本机字节序的 FLOAT32 字节。
 */
function encodeEmbedding(vector: EmbeddingVector): Buffer {
  // 先复制进新分配、byteOffset 为 0 的 Float32Array，保证 Buffer 视图与原始 ArrayBuffer 对齐。
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer);
}

/**
 * 将 FLOAT32 原始字节解码回数值向量。
 *
 * @param value Redis 返回的二进制字段（Buffer）；缺失或非 Buffer 时返回空数组。
 * @returns 数值向量。
 */
function decodeEmbedding(value: Buffer | undefined): number[] {
  if (!value || !Buffer.isBuffer(value) || value.byteLength === 0) return [];
  // 复制到对齐的独立 buffer，规避 redis 返回 Buffer 的 byteOffset 非 4 对齐时构造 Float32Array 抛错。
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return Array.from(new Float32Array(copy.buffer));
}

/**
 * 由 Redis chunk hash 重建 EmbeddedChunk。
 *
 * @param hash 已按 Buffer 读回的 chunk hash。
 * @param conversationId 会话标识。
 * @param documentId 附件逻辑文档标识。
 * @param chunkIndex chunk 序号。
 * @returns 完整 EmbeddedChunk。
 */
function buildChunk(
  hash: Record<string, Buffer>,
  conversationId: string,
  documentId: string,
  chunkIndex: number
): EmbeddedChunk {
  const text = readField(hash, "text");
  const heading = readField(hash, "heading");
  const pageNumber = numberField(hash, "pageNumber");
  const lineStart = numberField(hash, "lineStart");
  const lineEnd = numberField(hash, "lineEnd");
  // source 由 upsert 持久化；对本次改动前写入的旧 key 回退到 documentId，避免 citation 来源为空。
  const source = readField(hash, "source") || documentId;
  const chunkId = `${documentId}_chunk_${chunkIndex}`;
  return {
    chunkId,
    id: chunkId,
    documentId,
    source,
    chunkIndex,
    text,
    charStart: 0,
    charEnd: text.length,
    startOffset: 0,
    endOffset: text.length,
    ...(pageNumber !== undefined ? { page: pageNumber, pageNumber } : {}),
    ...(heading ? { heading } : {}),
    metadata: {
      conversationId,
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {})
    },
    embedding: decodeEmbedding(hash["embedding"]),
    embeddingModel: ATTACHMENT_EMBEDDING_MODEL
  };
}

/**
 * @param hash chunk hash。 @param field 字段名。 @returns UTF-8 字符串；缺失为空串。
 */
function readField(hash: Record<string, Buffer>, field: string): string {
  const value = hash[field];
  return value && Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

/**
 * @param hash chunk hash。 @param field 字段名。 @returns 数值；缺失或不可解析为 undefined。
 */
function numberField(hash: Record<string, Buffer>, field: string): number | undefined {
  const raw = readField(hash, field);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 从 chunk metadata 读取数值字段（chunking 把 lineStart/lineEnd/pageNumber 放在这里）。
 *
 * @param metadata chunk metadata。
 * @param key 字段名。
 * @returns 数值；缺失或非数值时为 undefined。
 */
function metadataNumber(metadata: Record<string, string | number | boolean | null>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

/** @param conversationId 会话标识。 @returns docs 集合 key。 */
function conversationDocsKey(conversationId: string): string {
  return `attach:conv:${conversationId}:docs`;
}

/** @param conversationId 会话标识。 @param documentId 附件文档标识。 @returns doc hash key。 */
function conversationDocKey(conversationId: string, documentId: string): string {
  return `attach:conv:${conversationId}:doc:${documentId}`;
}

/**
 * @param conversationId 会话标识。
 * @param documentId 附件文档标识。
 * @param index chunk 序号。
 * @returns chunk hash key。
 */
function conversationChunkKey(conversationId: string, documentId: string, index: number): string {
  return `attach:conv:${conversationId}:doc:${documentId}:chunk:${index}`;
}

/**
 * 内联原文槽的 Redis key（P2-B / §8.2 row C）。
 *
 * 与 chunk key 共享 `attach:conv:{convId}:doc:{docId}:` 前缀，但后缀为 `:inline`，
 * 值为 JSON string `{ text, source, fileName }`（无 chunkIndex 维度——内联槽以 documentId 为键唯一覆盖）。
 *
 * @param conversationId 会话标识。
 * @param documentId 附件文档标识。
 * @returns inline key。
 */
function conversationInlineKey(conversationId: string, documentId: string): string {
  return `attach:conv:${conversationId}:doc:${documentId}:inline`;
}

/** @param value 待检查字符串。 @returns 是否为空或纯空白。 */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

/** @returns invalid_attachment_scope 结构化失败。 */
function invalidScope(): { ok: false; error: RagStructuredError } {
  return { ok: false, error: { code: "invalid_attachment_scope", message: "附件检索必须提供非空的会话与文档范围。" } };
}

/** @returns 不泄漏 Redis 连接信息或驱动原始消息的失败。 */
function storeFailure(): { ok: false; error: RagStructuredError } {
  return { ok: false, error: { code: "attachment_store_failed", message: "附件临时存储暂时不可用，请稍后重试。" } };
}
