import type { RagAnswerDto } from "./rag.js";

/**
 * Eval case DTO 描述单条 RAG 回归评测输入和期望约束。
 *
 * 扩展字段说明：
 * - `expectedAnswer`：人工撰写的期望回答要点，用于可解释 correctness 检查。
 * - `expectedKeywords`：答案中期望出现的关键词集合；deterministic correctness 可基于关键词覆盖度打分。
 * - `requiredDocumentIds`：期望被召回的文档 id 列表，用于计算 retrieval hit rate。
 * - `requiredSources`：期望被召回的文档 source 列表，作为 documentId 不稳定时的替代命中条件。
 * - `expectedChunkIds`：可选，期望进入 topK 的具体 chunk id，用于更严格的 chunk-level 命中检查。
 * - `minCitations`：答案中至少需要的引用数量，用于 citation coverage 指标。
 * - `tags`：用于按主题、难度或文档来源分组统计。
 */
export interface EvalCaseDto {
  id: string;
  question: string;
  expectedAnswer?: string;
  expectedKeywords?: string[];
  requiredDocumentIds?: string[];
  requiredSources?: string[];
  expectedChunkIds?: string[];
  minCitations?: number;
  tags?: string[];
}

/**
 * Eval metric DTO 表达单项评测指标，便于后续报告和 CI 回归消费。
 */
export interface EvalMetricDto {
  name: string;
  score: number;
  passed: boolean;
  details?: string;
}

/**
 * Eval result DTO 聚合模型回答和指标结果，是 eval 报告的跨边界输出。
 */
export interface EvalResultDto {
  caseId: string;
  question: string;
  answer: RagAnswerDto;
  expectedAnswer?: string;
  metrics: EvalMetricDto[];
  passed: boolean;
}

/**
 * RAG 评测总体指标 DTO，用于报告和 CI 回归阈值判断。
 */
export interface RagEvalMetricsDto {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  retrievalHitRate: number;
  answerCorrectness: number;
  faithfulness: number;
  citationCoverage: number;
}

/**
 * 单条失败案例记录 DTO，便于回溯 query、召回、答案和引用。
 */
export interface RagEvalFailureDto {
  caseId: string;
  question: string;
  answerText: string;
  expectedAnswer?: string;
  retrievedChunkIds: string[];
  citationChunkIds: string[];
  failedMetrics: EvalMetricDto[];
  analysis: string;
}

/**
 * RAG 评测报告 DTO，包含总体指标、逐条结果、失败案例和优化建议。
 */
export interface RagEvalReportDto {
  metrics: RagEvalMetricsDto;
  results: EvalResultDto[];
  failures: RagEvalFailureDto[];
  recommendations: string[];
}
