/**
 * finance-api 评测数据集模块（v2.0 Step 3 · finance-eval-dataset 工作项）。
 *
 * 领域类型归属本文件（不进 @aiagent/types，兑现「领域 case 类型不进 types」）：
 * 金融评测 case schema 是金融语义，与跨边界线格式 EvalReportDto 解耦。
 * 仅 EvalReportDto 等跨边界 DTO 走 @aiagent/types（在 index.ts 引用）。
 *
 * 关键约束（修 G1 / G8）：
 * - 每个 case 携带真实 documents（deterministic 档要真实 ingest，禁止 fixture 回放）。
 * - 命中约束收敛为 source 级 + 可选 documentId 级（已删原 expectedChunkIds）。
 *   权威数据集 `datasets/finance/rag-v1.json` 由 test/generate-finance-rag-v1.mjs 生成，
 *   刻意**不设 expectedDocumentIds**（真实 documentId 是 ingest 生成的 UUID，无法预知，
 *   source 级 `expectedSources` 才是主判定路径，见 FinanceEvalCase.expectedDocumentIds）。
 * - 新增与切块解耦的语义级 goldEvidence（喂给 llmContextRecall judge）。
 * - loader 做数据集级 minCases 校验（不再硬校验 30-50）。
 */

import { readFileSync } from "node:fs";
import {
  decodeFinanceEvalDocumentContent,
  type FinanceEvalByteContentEnvelope,
  type SerializedFinanceEvalContent
} from "./adapter.js";

/**
 * 单篇待 ingest 文档（deterministic 档真实写入 DataSourceRuntime）。
 *
 * 与 source 对齐：每篇文档对应一个逻辑来源（annual/q3/industry/announcement 等），
 * content 为可检索全文（具体聚合粒度由权威生成器决定：全局按 source 拼接跨 case 事实），
 * 保证 ingest 后能真实检索到证据。
 */
export interface FinanceEvalDocument {
  /** 逻辑来源标识（与 expectedSources 对齐，如 annual/q3/industry）。 */
  source: string;
  /** 文件名（含扩展名），仅用于 lineage 与可调试性。 */
  fileName: string;
  /** 文档全文（Markdown/TXT），会被 runtime 切块、embedding、索引。 */
  content: string | Uint8Array;
  /** 图片型来源的页面引用。 */
  pageImageRef?: string | null;
  /** 来源类别，默认 text。 */
  sourceKind?: "text" | "image";
}

/**
 * 金融评测单条 case（领域 schema，不进 @aiagent/types）。
 *
 * 命中约束由粗到细：
 * - expectedSources（source 级，最粗，必填于 rag 类）；
 * - expectedDocumentIds（可选 document 级，删掉原 expectedChunkIds）；
 * - goldEvidence（与切块解耦的语义级期望证据，喂 judge）。
 */
export interface FinanceEvalCase {
  /** case 唯一 id（迁移时保持原 id 不变）。 */
  id: string;
  /** 查询问题。 */
  query: string;
  /** 执行档位下对应的执行模式（rag 类 deterministic 档真实跑检索+answer）。 */
  mode: "chat" | "rag" | "report" | "failure";
  /** 真实待 ingest 文档集合（deterministic 档真实写入 runtime，修 G1）。 */
  documents: FinanceEvalDocument[];
  /** source 级命中约束（rag 类为 expectedCitations）。 */
  expectedSources?: string[];
  /**
   * 可选 document 级命中约束。
   *
   * 注意：真实 `citation.documentId` 是 ingest 时生成的 UUID，数据集生成阶段无法预知，
   * 因此本字段在 `datasets/finance/rag-v1.json`（权威生成器 test/generate-finance-rag-v1.mjs）
   * 中**刻意留空**；命中判定以 `expectedSources`（source 级）为主路径，`metrics.ts` 的
   * documentId 匹配仅作可选增强、缺失不影响 source 级回退。切勿把 source 列表回填到此处，
   * 否则会让 documentId 优先匹配分支恒为 0，掩盖真实召回。
   */
  expectedDocumentIds?: string[];
  /** 关键词级期望（answerCorrectness 近似覆盖），中文 2-gram + 英文词。 */
  expectedKeywords?: string[];
  /** 期望答案（可选，关键词/子串近似匹配用）。 */
  expectedAnswer?: string;
  /** 与切块解耦的语义级期望证据（喂 llmContextRecall judge，修前置 #4）。 */
  goldEvidence?: string[];
  /** 最低引用数门槛（citationCoverage 用，rag 类默认 2）。 */
  minCitations?: number;
  /** 自由标签（用于报告分组 / 失败回灌分流）。 */
  tags?: string[];
}

/**
 * 金融评测数据集（loader 解析产物）。
 */
export interface FinanceEvalDataset {
  /** schema 版本（如 2.0.0）。 */
  schemaVersion: string;
  /** 数据集版本标识（如 finance-rag-v1.0.0）。 */
  datasetVersion: string;
  /** 随机种子（可复现性）。 */
  seed?: number;
  /** 数据集领域（默认 finance）。 */
  domain?: string;
  /** 数据集级最小 case 数（修 G8：不再硬校验 30-50）。 */
  minCases: number;
  /** 全部 case。 */
  cases: FinanceEvalCase[];
}

/**
 * loader 选项。
 */
export interface LoadFinanceDatasetOptions {
  /** 数据集级最小 case 数下限；缺省取数据集自带的 minCases（仍不得低于 1）。 */
  minCases?: number;
}

/**
 * 校验单个 case 的基础结构合法性，不合法时抛出带 id 的错误。
 *
 * @param case_ 待校验 case。
 */
function assertCaseShape(case_: unknown, index: number): asserts case_ is FinanceEvalCase {
  if (typeof case_ !== "object" || case_ === null) {
    throw new Error(`case[${index}] 不是对象`);
  }
  const c = case_ as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) {
    throw new Error(`case[${index}] 缺少合法 id`);
  }
  if (typeof c.query !== "string" || c.query.length === 0) {
    throw new Error(`case ${c.id} 缺少合法 query`);
  }
  if (!["chat", "rag", "report", "failure"].includes(c.mode as string)) {
    throw new Error(`case ${c.id} mode 非法：${String(c.mode)}`);
  }
  if (!Array.isArray(c.documents)) {
    throw new Error(`case ${c.id} documents 必须是数组`);
  }
  for (const doc of c.documents as unknown[]) {
    if (typeof doc !== "object" || doc === null) {
      throw new Error(`case ${c.id} documents 含非对象元素`);
    }
    const d = doc as Record<string, unknown>;
    const serializedContent = isSerializedDocument(d) ? d.content : undefined;
    if (
      typeof d.source !== "string"
      || typeof d.fileName !== "string"
      || serializedContent === undefined
    ) {
      throw new Error(`case ${c.id} document 缺少 source/fileName/content`);
    }
    d.content = decodeFinanceEvalDocumentContent(serializedContent);
    if (typeof d.pageImageRef !== "string") d.pageImageRef = null;
    if (d.sourceKind !== "image") d.sourceKind = "text";
  }
}

/**
 * 校验 JSON 文档内容是文本或 base64 字节信封。
 *
 * @param value 未知 document content。
 * @returns 是否为合法序列化内容。
 */
function isSerializedDocument(value: unknown): value is Record<string, unknown> & { content: SerializedFinanceEvalContent } {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Record<string, unknown>;
  const content = document.content;
  if (typeof content === "string") return true;
  if (typeof content !== "object" || content === null) return false;
  const envelope = content as FinanceEvalByteContentEnvelope;
  return envelope.contentEncoding === "base64" && typeof envelope.contentBase64 === "string";
}

/**
 * 加载并校验金融评测数据集。
 *
 * 校验内容：
 * - JSON 可解析、含 cases 数组；
 * - 每个 case 结构合法（见 assertCaseShape）；
 * - 校验 case 数不低于数据集级 minCases（修 G8，不再硬校验 30-50）；
 * - 顺带交叉校验 rag 类 case 必带 documents（deterministic 档真实检索的前提，否则属数据集错误）。
 *
 * @param path 数据集 JSON 路径。
 * @param options 可选 minCases 覆盖。
 * @returns 解析后的数据集。
 */
export function loadFinanceDataset(path: string, options: LoadFinanceDatasetOptions = {}): FinanceEvalDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`无法解析数据集 ${path}：${(err as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).cases)) {
    throw new Error(`数据集 ${path} 缺少 cases 数组`);
  }
  const data = raw as Record<string, unknown>;
  const cases = data.cases as unknown[];

  cases.forEach((c, i) => assertCaseShape(c, i));

  const minCases = Math.max(1, options.minCases ?? (typeof data.minCases === "number" ? data.minCases : 1));
  if (cases.length < minCases) {
    throw new Error(`数据集 case 数 ${cases.length} 低于数据集级下限 ${minCases}（修 G8：不再硬校验 30-50）`);
  }

  // rag 类 case 必须带真实 documents，否则 deterministic 档无法真实检索（修 G1 前提）。
  for (const c of cases as FinanceEvalCase[]) {
    if (c.mode === "rag" && c.documents.length === 0) {
      throw new Error(`rag case ${c.id} 未携带 documents，deterministic 档无法真实检索（修 G1）`);
    }
  }

  return {
    schemaVersion: typeof data.schemaVersion === "string" ? data.schemaVersion : "2.0.0",
    datasetVersion: typeof data.datasetVersion === "string" ? data.datasetVersion : "finance-rag-v1.0.0",
    seed: typeof data.seed === "number" ? data.seed : undefined,
    domain: typeof data.domain === "string" ? data.domain : "finance",
    minCases,
    cases: cases as FinanceEvalCase[],
  };
}
