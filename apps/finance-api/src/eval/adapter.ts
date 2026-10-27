/**
 * finance-api 确定性 RAG 评测适配器（v2.0 评测体系 Step 3，领域自治方案 §3.3）。
 *
 * 本模块把 `@aiagent/rag` 的真实 runtime 装配为「确定性可复现」的评测执行后端：
 * - 内存 repository（createInMemoryRagDocumentRepository）
 * - 内存 owner-bound vector store（createInMemoryVectorStoreFactory）
 * - deterministic mock embedding（createDeterministicMockEmbeddingClient，稳定可复现向量）
 *
 * 关键：deterministic 档**真实调用 `DataSourceRuntime.answer()`**（检索 + 生成），
 * 禁止用 fixture 回放 retrievedChunks（修 G1）。本适配器先 ingest 真实 documents，
 * 再返回装配好的 runtime 供 run 工作项调用。
 *
 * 本文件零 `@aiagent/eval` 依赖，仅 import `@aiagent/rag`（运行时）与 `import type @aiagent/types`。
 */

import {
  createDataSourceRuntime,
  createInMemoryRagDocumentRepository,
  createInMemoryVectorStoreFactory,
  createDeterministicMockEmbeddingClient,
  type DataSourceRuntime,
  type DataSourceRuntimeOptions
} from "@aiagent/rag";
import type { RagAnswer } from "@aiagent/rag";
import type { RetrievalResult } from "@aiagent/rag";

/**
 * 评测用 ingest 文档（最小投影）：与 dataset.ts 导出的 `FinanceEvalDocument` 对齐。
 *
 * 字段刻意只取 `DataSourceIngestRequestDto` 所需的三元组，便于 adapter 直接 ingest，
 * 而不与 dataset 内部 schema 强耦合。
 */
export interface FinanceEvalDocumentLike {
  /** 来源标识（URI / 逻辑名），对应 DataSourceIngestRequestDto.source。 */
  source: string;
  /** 文件名，对应 DataSourceIngestRequestDto.fileName。 */
  fileName: string;
  /** 文档全文或 PDF 原始字节，对应 DataSourceIngestRequestDto.content。 */
  content: string | Uint8Array;
  /** 图片型来源的页面引用；文本来源可为空。 */
  pageImageRef?: string | null;
  /** 来源类别，默认 text。 */
  sourceKind?: "text" | "image";
}

/** JSON 数据集中承载二进制文档的稳定信封。 */
export interface FinanceEvalByteContentEnvelope {
  /** 声明内容为 base64 编码的二进制。 */
  contentEncoding: "base64";
  /** PDF 等二进制文档的 base64 文本。 */
  contentBase64: string;
}

/** loader + adapter 共同接受的序列化文档内容。 */
export type SerializedFinanceEvalContent = string | FinanceEvalByteContentEnvelope;

/**
 * 将 JSON 数据集里的文本或 base64 字节信封解码为运行时内容。
 *
 * @param content 序列化文档内容。
 * @returns 原文本或 Uint8Array 字节。
 */
export function decodeFinanceEvalDocumentContent(
  content: SerializedFinanceEvalContent
): string | Uint8Array {
  if (typeof content === "string") return content;

  return new Uint8Array(Buffer.from(content.contentBase64, "base64"));
}

/**
 * RAG 证据投影（RagAnswer → 评测关心的子集）。
 *
 * 把 runtime 返回的完整 `RagAnswer` 收束为指标计算所需的字段，隔离「线格式 DTO」
 * 与「评测指标输入」，便于 run/metrics 工作项只依赖这个稳定投影。
 */
export interface FinanceRagEvidence {
  /** 生成的回答文本。 */
  answer: string;
  /** 引用列表（含 source / documentId / quote 等）。 */
  citations: RagAnswer["citations"];
  /** 检索结果列表（含 rank / score / documentId / source）。 */
  retrievalResults: RetrievalResult[];
  /** 结构化拒答信号（前置修正 #1）；undefined 表示未携带。 */
  status: RagAnswer["status"];
}

/**
 * 创建确定性金融 RAG runtime（内存替身 + 真实检索/生成链路）。
 *
 * 装配内存 repository + 内存 vector store + deterministic mock embedding，先 ingest
 * 传入的 documents（每个 document 一次 ingest，owner 用匿名 shared scope），再返回装配好的
 * runtime。调用方随后对每条 case 真实调用 `runtime.answer(question)` 得到 `RagAnswer`。
 *
 * @param documents 待 ingest 的评测文档（deterministic 档用真实 documents，禁用 fixture 回放，修 G1）。
 * @param options 可选 runtime 覆盖（如注入 chunkingOptions / evidenceSufficiencyThreshold，对应前置修正 #5/#1）。
 * @returns 已 ingest 文档、可直接 answer 的 DataSourceRuntime。
 */
export async function createDeterministicFinanceRagRuntime(
  documents: readonly FinanceEvalDocumentLike[],
  options: DataSourceRuntimeOptions = {}
): Promise<DataSourceRuntime> {
  const chunkingOptions = options.chunkingOptions ?? {
    strategy: "table_aware",
    maxChars: 1200,
    overlapChars: 150
  };
  const runtime = createDataSourceRuntime({
    repository: createInMemoryRagDocumentRepository(),
    vectorStoreFactory: createInMemoryVectorStoreFactory(),
    embeddingClient: createDeterministicMockEmbeddingClient(),
    // 透传可选注入点（前置修正 #5/#1）：切块策略与证据充分性阈值，缺省回落 rag 内置默认。
    chunkingOptions,
    ...(options.evidenceSufficiencyThreshold !== undefined
      ? { evidenceSufficiencyThreshold: options.evidenceSufficiencyThreshold }
      : {})
  });

  for (const document of documents) {
    const result = await runtime.ingest({
      source: document.source,
      fileName: document.fileName,
      content: document.content
    });

    if (!result.ok) {
      throw new Error(
        `评测文档 ingest 失败（source=${document.source}）：[${result.error.code}] ${result.error.message}`
      );
    }
  }

  return runtime;
}

/**
 * 从 `RagAnswer` 抽取评测证据投影。
 *
 * 供 run 工作项在每次 `runtime.answer()` 后调用，把线格式 DTO 收束为指标输入。
 *
 * @param answer 真实 runtime 产出的 RAG answer。
 * @returns 评测证据投影。
 */
export function projectRagEvidence(answer: RagAnswer): FinanceRagEvidence {
  return {
    answer: answer.answer,
    citations: answer.citations,
    retrievalResults: answer.retrievalResults,
    status: answer.status
  };
}
