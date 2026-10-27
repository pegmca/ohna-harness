import { detectDocumentFileType, ingestDocument } from "@aiagent/parsing";
import type {
  DataSourceDocumentDto,
  DataSourceIngestRequestDto,
  DataSourceIngestResponseDto,
  IngestedDocumentDto
} from "@aiagent/types";
import {
  createInMemoryRagDocumentRepository,
  validateRagOwnerScope,
  type RagDocumentRepository,
  type SaveRagIngestionInput,
  type SaveRagIngestionResult
} from "./document-repository.js";
import {
  createRetrievalResultFromRetrievedChunk,
  synthesizeRagAnswer
} from "./answer.js";
import { chunkIngestedDocument } from "./chunking.js";
import { createHybridRetriever } from "./retrieval.js";
import {
  createRagContentChecksum,
  createTraceRetrievalEvent,
  isSafeRagSourceUri,
  normalizeRagSourceUri,
  ragChunkRecordToChunk,
  resolveRagSourceType,
  toNewChunkRecord
} from "./source-uri.js";
import {
  DEFAULT_CHUNKING_OPTIONS,
  RAG_PARSER_VERSION,
  resolveChunkerVersion,
  type ChunkingOptions,
  type DataSourceIngestContext,
  type DataSourceListChunksOptions,
  type DataSourceListOptions,
  type DataSourceRetrievalContext,
  type DataSourceRuntime,
  type DataSourceRuntimeOptions,
  type DataSourceRuntimeResult,
  type EmbeddingClient,
  type EvidenceSufficiencyThreshold,
  type KeywordCandidateStore,
  type RagAnswerRuntimeResponse,
  type RagChunk,
  type RagPackageSummary,
  type RagSearchRuntimeResponse,
  type RagStructuredError,
  type Reranker,
  type RetrievalOptions,
  type Retriever,
  type VectorStore
} from "./types.js";
import type { QueryRewriter } from "./query-rewrite.js";
import { createInMemoryVectorStoreFactory } from "./vector-store.js";

/**
 * 创建 RAG package 的边界摘要，明确本阶段只提供骨架和稳定类型。
 *
 * @returns RAG package 的职责边界和当前实现状态。
 */
export function createRagPackageSummary(): RagPackageSummary {
  return {
    packageName: "@aiagent/rag",
    boundary: "chunking_embedding_retrieval_citation_answer",
    runtimeState: "hybrid_retrieval_ready"
  };
}

/**
 * 创建 Data Sources runtime。
 *
 * 文档 lineage、embedding client 与按 owner 绑定的 VectorStore 均可由 composition root 注入。
 * repository 与 VectorStore factory 缺省使用内存 adapter；embedding client 必须显式注入，
 * 未注入时 ingest/search/answer 返回结构化的 provider disabled 错误，绝不生成 mock 向量。
 *
 * @param options repository、embedding client 与 owner-bound VectorStore factory。
 * @returns 可执行 ingest、list、search 和 grounded answer 的 runtime。
 */
export function createDataSourceRuntime(options: DataSourceRuntimeOptions = {}): DataSourceRuntime {
  return new DataSourceRuntimeService(options);
}

/**
 * Data Sources runtime 实现，负责把 parsing ingestion、lineage 持久化和 RAG 检索链路串起来。
 *
 * 文档/版本/chunk 事实源是注入的 repository；VectorStore factory 按当前 owner 绑定具体 adapter。
 */
class DataSourceRuntimeService implements DataSourceRuntime {
  private readonly embeddingClient?: EmbeddingClient;
  private readonly vectorStoreFactory: (ownerUserId: string | null) => VectorStore;
  /** 外置关键词候选存储工厂（P3）；注入后关键词召回走共享存储，进程内不再持有整库 chunks。 */
  private readonly keywordStoreFactory?: (ownerUserId: string | null) => KeywordCandidateStore;
  private readonly repository: RagDocumentRepository;
  private readonly reranker?: Reranker;
  private readonly contextEnricher?: (
    document: IngestedDocumentDto,
    chunks: RagChunk[]
  ) => Promise<RagChunk[]>;
  private readonly queryRewriter?: QueryRewriter;
  /**
   * ingest 切块策略（前置修正 #5）：注入后覆盖默认 DEFAULT_CHUNKING_OPTIONS；
   * 缺省 undefined 时 ingest 透传 undefined，由 chunkIngestedDocument 回落默认切块，行为不变。
   */
  private readonly chunkingOptions?: ChunkingOptions;
  /**
   * 证据充分性阈值（前置修正 #1）：传给 synthesizeRagAnswer 控制拒答灵敏度；
   * 缺省 undefined 时透传空对象，由 synthesizeRagAnswer 沿用内置 0.15 / 0.42 常量，零回归。
   */
  private readonly evidenceThreshold: EvidenceSufficiencyThreshold;

  /**
   * 创建 runtime 实例。
   *
   * repository / vectorStoreFactory 缺省回退到内存实现，便于调用方按需替换持久化 adapter；
   * embeddingClient 不设默认值：生产必须注入真实 client，测试必须显式注入 testing.ts 替身；
   * reranker / contextEnricher / queryRewriter 均为可选生产增强，传 null/undefined 时视作"未注入"，
   * 分别由 HybridRetriever 的 HeuristicReranker 保底、保持 chunk 原样、保持原 query。
   * chunkingOptions / evidenceSufficiencyThreshold 为可选注入点，缺省时回落默认行为。
   *
   * @param options 显式 adapter 依赖与可选生产增强。
   */
  public constructor(options: DataSourceRuntimeOptions) {
    this.repository = options.repository ?? createInMemoryRagDocumentRepository();
    this.embeddingClient = options.embeddingClient ?? undefined;
    this.vectorStoreFactory = options.vectorStoreFactory ?? createInMemoryVectorStoreFactory();
    this.keywordStoreFactory = options.keywordStoreFactory;
    // 生产增强项为 null 时归一为 undefined，等价于"未注入"；HybridRetriever 会用自己的 HeuristicReranker 保底。
    this.reranker = options.reranker ?? undefined;
    this.contextEnricher = options.contextEnricher ?? undefined;
    this.queryRewriter = options.queryRewriter ?? undefined;
    // 切块策略注入点（前置修正 #5）：缺省 undefined 时由 chunkIngestedDocument 回落 DEFAULT_CHUNKING_OPTIONS。
    this.chunkingOptions = options.chunkingOptions;
    // 阈值注入点（前置修正 #1）：未注入时透传空对象，synthesizeRagAnswer 用内置默认常量（零回归）。
    this.evidenceThreshold = options.evidenceSufficiencyThreshold ?? {};
  }

  /**
   * ingest Markdown/TXT 文档：解析、切块、持久化 lineage、生成 embedding 并写入内存向量库。
   *
   * 持久化语义：
   * - externalId 是 source/fileName/fileType 的 SHA-256，同来源重复 ingest 落到同一文档；
   * - contentChecksum 相同的已 indexed 版本直接幂等命中（deduplicated），不重复建版本和 chunk，
   *   但仍用 repository 返回的 chunks 重新 embed 并 upsert，保证同进程 search 可用；
   * - 解析或切块失败也落 failed 版本（结构化错误），修复内容后可重试产生新版本。
   *
   * @param request API 校验后的 data source ingestion 请求。
   * @param context owner 与 scope；缺省匿名落 shared scope。
   * @returns 文档、chunks、版本号、幂等标记和索引数量；失败时返回结构化 RAG 错误。
   */
  public async ingest(
    request: DataSourceIngestRequestDto,
    context: DataSourceIngestContext = {}
  ): Promise<DataSourceRuntimeResult<DataSourceIngestResponseDto>> {
    const embeddingClient = this.embeddingClient;
    if (embeddingClient === undefined) {
      return {
        ok: false,
        error: {
          code: "embedding_provider_disabled",
          message: "Embedding provider 未启用，无法为 data source 建立向量索引。",
          details: { reason: "embedding_client_not_injected" }
        }
      };
    }

    const ownerUserId = context.ownerUserId ?? null;
    const scope = context.scope ?? (ownerUserId ? "private" : "shared");
    const ownerScopeViolation = validateRagOwnerScope({ ownerUserId, scope });

    if (ownerScopeViolation !== undefined) {
      return {
        ok: false,
        error: {
          code: "ingestion_failed",
          message: "ingest 请求的 owner/scope 组合非法。",
          details: { reason: ownerScopeViolation }
        }
      };
    }

    if (!isSafeRagSourceUri(request.source)) {
      return {
        ok: false,
        error: {
          code: "ingestion_failed",
          message: "Data source 标识不合法：仅支持 http(s) URL、mock:/demo: URI 或相对逻辑标识。",
          details: { reason: "unsafe_source_uri" }
        }
      };
    }

    // sourceUri 是脱敏后的逻辑标识：http(s) URL 剥离 query/fragment，
    // 同一文档带不带 token 命中同一 lineage，落库与 DTO 返回值永远不含敏感参数。
    const sourceUri = normalizeRagSourceUri(request.source);
    const fileType = detectDocumentFileType(request.fileName, request.contentType);
    const externalId = createRagContentChecksum(`${sourceUri}|${request.fileName}|${fileType ?? "unknown"}`);
    const contentChecksum = createRagContentChecksum(request.content);
    const contentType = request.contentType?.trim() || "unknown";
    const now = new Date().toISOString();
    const lineageBase = {
      ownerUserId,
      scope,
      sourceType: resolveRagSourceType(sourceUri),
      externalId,
      sourceUri,
      contentType,
      contentChecksum,
      content: request.content,
      parserVersion: RAG_PARSER_VERSION,
      chunkerVersion: resolveChunkerVersion(this.chunkingOptions ?? DEFAULT_CHUNKING_OPTIONS),
      now
    } as const;

    const ingestionResult = ingestDocument({
      source: sourceUri,
      fileName: request.fileName,
      contentType: request.contentType,
      content: request.content
    });

    if (!ingestionResult.ok) {
      const error = {
        code: "ingestion_failed" as const,
        message: ingestionResult.error.message,
        details: {
          filingCode: ingestionResult.error.code,
          ...ingestionResult.error.details
        }
      };
      await this.saveLineage({
        ...lineageBase,
        title: request.fileName,
        outcome: {
          status: "failed",
          error: { code: ingestionResult.error.code, message: ingestionResult.error.message, details: ingestionResult.error.details }
        }
      });
      return { ok: false, error };
    }

    const chunkingResult = chunkIngestedDocument(ingestionResult.document, this.chunkingOptions ?? DEFAULT_CHUNKING_OPTIONS);

    if (!chunkingResult.ok) {
      await this.saveLineage({
        ...lineageBase,
        title: ingestionResult.document.title,
        outcome: {
          status: "failed",
          error: { code: chunkingResult.error.code, message: chunkingResult.error.message, details: chunkingResult.error.details }
        }
      });
      return { ok: false, error: chunkingResult.error };
    }

    const saved = await this.saveLineage({
      ...lineageBase,
      title: ingestionResult.document.title,
      outcome: {
        status: "indexed",
        chunks: chunkingResult.chunks.map(toNewChunkRecord)
      }
    });

    if (!saved.ok) {
      return { ok: false, error: saved.error };
    }

    // 统一从 repository 返回的记录重建 RagChunkDto，幂等命中与新建版本走完全相同的形状。
    const chunks = saved.result.chunks.map(ragChunkRecordToChunk);
    // Contextual Retrieval 挂载点①：ingest 时对 chunk 拼接文档级 LLM 上下文前缀再 embedding，
    // 让写入向量库的向量带上"全局坐标"，检索召回更准；缺省无注入（恒等）保持零依赖可复现。
    const indexedChunks = this.contextEnricher
      ? await this.contextEnricher(ingestionResult.document, chunks)
      : chunks;
    const embeddingResult = await embeddingClient.embedTexts(indexedChunks.map((chunk) => chunk.text));

    if (!embeddingResult.ok) {
      return { ok: false, error: embeddingResult.error };
    }

    const embeddedChunks = indexedChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddingResult.embeddings[index].vector,
      embeddingModel: embeddingResult.model
    }));
    const upsertResult = await this.vectorStoreFactory(ownerUserId).upsertChunks(embeddedChunks);

    if (!upsertResult.ok) {
      return {
        ok: false,
        error: {
          code: "indexing_failed",
          message: upsertResult.error.message,
          details: upsertResult.error.details
        }
      };
    }

    return {
      ok: true,
      data: {
        document: { ...ingestionResult.document, documentId: saved.result.document.id },
        chunks,
        indexedChunkCount: embeddedChunks.length,
        documentVersion: saved.result.version.version,
        deduplicated: saved.result.kind === "existing"
      }
    };
  }

  /**
   * 经 repository 分页列出可见文档摘要。
   *
   * @param options owner、cursor 与 limit；缺省匿名第一页。
   * @returns 文档摘要页与下一页 cursor。
   */
  public async listDocuments(
    options: DataSourceListOptions = {}
  ): Promise<{ documents: DataSourceDocumentDto[]; nextCursor: string | null }> {
    return this.repository.listDocuments({
      ownerUserId: options.ownerUserId ?? null,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });
  }

  /**
   * 经 repository 分页列出可见 chunks，并重建为不暴露向量的 RagChunkDto。
   *
   * @param options owner、可选 documentId、cursor 与 limit。
   * @returns chunk 页与下一页 cursor。
   */
  public async listChunks(
    options: DataSourceListChunksOptions = {}
  ): Promise<{ chunks: RagChunk[]; nextCursor: string | null }> {
    const page = await this.repository.listChunks({
      ownerUserId: options.ownerUserId ?? null,
      ...(options.documentId !== undefined ? { documentId: options.documentId } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    });

    return {
      chunks: page.chunks.map(ragChunkRecordToChunk),
      nextCursor: page.nextCursor
    };
  }

  /**
   * 执行 RAG search，并返回带 citation 的 retrieval results。
   *
   * @param query 用户查询。
   * @param options topK、mode 等检索选项。
   * @returns search 结果和脱敏 trace event。
   */
  public async search(
    query: string,
    options: RetrievalOptions = {},
    context: DataSourceRetrievalContext = {}
  ): Promise<DataSourceRuntimeResult<RagSearchRuntimeResponse>> {
    const retriever = await this.retriever(context);
    if (!retriever.ok) return retriever;
    // Agentic 检索挂载点：检索前把原始 query 改写为检索友好问句（缺省不改写），提升召回。
    const resolvedQuery = this.queryRewriter ? (await this.queryRewriter(query)).rewritten : query;
    const retrievalResult = await retriever.data.retrieve(resolvedQuery, options);
    const trace = createTraceRetrievalEvent(resolvedQuery, retrievalResult);

    if (!retrievalResult.ok) {
      return {
        ok: false,
        error: retrievalResult.error
      };
    }

    return {
      ok: true,
      data: {
        results: retrievalResult.results.map(createRetrievalResultFromRetrievedChunk),
        trace
      }
    };
  }

  /**
   * 基于召回结果合成短研究摘要；证据不足时明确返回未知，不编造结论。
   *
   * @param question 用户问题。
   * @param options topK、mode 等检索选项。
   * @returns grounded answer 和 retrieval trace。
   */
  public async answer(
    question: string,
    options: RetrievalOptions = {},
    context: DataSourceRetrievalContext = {}
  ): Promise<DataSourceRuntimeResult<RagAnswerRuntimeResponse>> {
    const retriever = await this.retriever(context);
    if (!retriever.ok) return retriever;
    // Agentic 检索挂载点：检索前把原始 question 改写为检索友好问句（缺省不改写），提升召回。
    const resolvedQuery = this.queryRewriter ? (await this.queryRewriter(question)).rewritten : question;
    const retrievalResult = await retriever.data.retrieve(resolvedQuery, options);
    const trace = createTraceRetrievalEvent(resolvedQuery, retrievalResult);

    if (!retrievalResult.ok) {
      return {
        ok: false,
        error: retrievalResult.error
      };
    }

    return {
      ok: true,
      data: {
        answer: synthesizeRagAnswer(question, retrievalResult.results, this.evidenceThreshold),
        trace
      }
    };
  }

  /**
   * 持久化 ingestion 终态；repository 异常映射为结构化错误，不向调用方泄漏原始异常。
   *
   * @param input saveIngestion 输入。
   * @returns 成功时返回 saveIngestion 结果，失败时返回结构化错误。
   */
  private async saveLineage(
    input: SaveRagIngestionInput
  ): Promise<{ ok: true; result: SaveRagIngestionResult } | { ok: false; error: RagStructuredError }> {
    try {
      return { ok: true, result: await this.repository.saveIngestion(input) };
    } catch {
      return {
        ok: false,
        error: {
          code: "indexing_failed",
          message: "RAG 文档 lineage 持久化失败，请稍后重试。"
        }
      };
    }
  }

  /**
   * 从持久化 repository 分页加载当前 owner 可见 chunks，并创建 hybrid retriever。
   *
   * P2 起提升为公开方法（原私有 createRetriever）：供多路召回编排器复用内部库 leg，
   * 与附件 leg 合并（对齐 §5.5 / D-P2-1），避免重造 hybrid/rerank。
   *
   * @param context 调用身份；ownerUserId 缺省匿名（只见 shared/demo）。
   * @returns 成功时返回绑定持久化向量库和 keyword candidates 的 retriever，失败时返回结构化错误。
   */
  public async retriever(
    context: DataSourceRetrievalContext = {}
  ): Promise<DataSourceRuntimeResult<Retriever>> {
    const ownerUserId = context.ownerUserId ?? null;
    const embeddingClient = this.embeddingClient;
    if (embeddingClient === undefined) {
      return {
        ok: false,
        error: {
          code: "embedding_provider_disabled",
          message: "Embedding provider 未启用，无法执行向量检索。",
          details: { reason: "embedding_client_not_injected" }
        }
      };
    }

    try {
      // P3：注入外置关键词候选存储时，关键词召回直接走共享存储，进程内不再把整库 chunks 载入内存做扫描，
      // 与向量召回共享同一份 Postgres 事实源、跨实例一致；此时无需为关键词路径加载/嵌入 chunks。
      // 未注入（无 DATABASE_URL / 单测）时退回既有内存语料路径，行为不变。
      const keywordStore = this.keywordStoreFactory?.(ownerUserId);
      if (keywordStore) {
        const keywordCorpus = await this.loadTableChunksForExpansion(ownerUserId, this.repository);
        if (!keywordCorpus.ok) return keywordCorpus;
        return {
          ok: true,
          data: createHybridRetriever({
            embeddingClient,
            vectorStore: this.vectorStoreFactory(ownerUserId),
            // 关键词候选已外置，内存语料置空（仅向量召回与打分需要，向量召回不消费 chunks）。
            chunks: [],
            keywordStore,
            tableChunks: keywordCorpus.data,
            reranker: this.reranker
          })
        };
      }

      const chunks: RagChunk[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.repository.listChunks({ ownerUserId, limit: 100, ...(cursor ? { cursor } : {}) });
        chunks.push(...page.chunks.map(ragChunkRecordToChunk));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const embeddingResult = await embeddingClient.embedTexts(chunks.map((chunk) => chunk.text));
      if (!embeddingResult.ok) return embeddingResult;
      const embeddedChunks = chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddingResult.embeddings[index].vector,
        embeddingModel: embeddingResult.model
      }));
      return {
        ok: true,
        data: createHybridRetriever({
          embeddingClient,
          vectorStore: this.vectorStoreFactory(ownerUserId),
          chunks: embeddedChunks,
          tableChunks: embeddedChunks.filter((chunk) =>
            chunk.metadata.isTableChunk === true || chunk.metadata.isTableSummary === true
          ),
          // 生产组合注入真实 Reranker（cross-encoder / LLM-judge）；缺省走内部 HeuristicReranker。
          reranker: this.reranker
        })
      };
    } catch {
      return {
        ok: false,
        error: { code: "retrieval_failed", message: "RAG 持久化候选读取失败，请稍后重试。" }
      };
    }
  }

  /**
   * 加载当前 owner 可见的整表相关 chunks，供检索侧 sibling 展开。
   *
   * @param ownerUserId 当前调用者。
   * @param repository 文档 repository。
   * @returns 整表与 summary chunks。
   */
  private async loadTableChunksForExpansion(
    ownerUserId: string | null,
    repository: RagDocumentRepository
  ): Promise<
    | { ok: true; data: Array<RagChunk & { embedding: readonly number[]; embeddingModel: string }> }
    | { ok: false; error: RagStructuredError }
  > {
    const chunks: RagChunk[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.listChunks({ ownerUserId, limit: 100, ...(cursor ? { cursor } : {}) });
      chunks.push(...page.chunks.map(ragChunkRecordToChunk));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const filtered = chunks.filter(
      (chunk) => chunk.metadata.isTableChunk === true || chunk.metadata.isTableSummary === true
    );
    const embeddingClient = this.embeddingClient;
    if (!embeddingClient) {
      return {
        ok: false,
        error: {
          code: "embedding_provider_disabled",
          message: "Embedding provider 未启用，无法展开整表检索结果。",
          details: { reason: "embedding_client_not_injected" }
        }
      };
    }
    if (filtered.length === 0) return { ok: true, data: [] };
    const embedded = await embeddingClient.embedTexts(filtered.map((chunk) => chunk.text));
    if (!embedded.ok) return embedded;

    return {
      ok: true,
      data: filtered.map((chunk, index) => ({
        ...chunk,
        embedding: embedded.embeddings[index].vector,
        embeddingModel: embedded.model
      }))
    };
  }
}
