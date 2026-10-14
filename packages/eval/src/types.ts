import type { EvalCaseDto, EvalResultDto, RagEvalReportDto } from "@aiagent/types";
import type { DataSourceRuntime, RagAnswer } from "@aiagent/rag";
import type { LlmJudge } from "./judge.js";

/**
 * RAG 评测用例，扩展共享 EvalCaseDto，并补充 runner 内部使用的位置信息。
 *
 * 位置字段 `documentId`/`chunkId` 用于验证 retrieval 是否命中期望证据，
 * 关键词字段用于 deterministic correctness 检查。
 */
export type RagEvalCase = EvalCaseDto;

/**
 * 单条 case 的运行结果，包含原始答案和计算后的指标。
 */
export type RagEvalRunResult = EvalResultDto;

/**
 * RAG 评测总体指标。
 */
export interface RagEvalMetrics {
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
 * 评测 runner 输入，调用方提供 case 集合、RAG runtime 和可选配置。
 */
export interface RagEvalRunnerInput {
  cases: readonly RagEvalCase[];
  runtime: DataSourceRuntime;
  options?: RagEvalRunnerOptions;
}

/**
 * 评测 runner 选项，允许调整 topK、召回模式、通过阈值和指标开关。
 */
export interface RagEvalRunnerOptions {
  topK?: number;
  mode?: "vector" | "keyword" | "hybrid";
  retrievalPassThreshold?: number;
  correctnessPassThreshold?: number;
  faithfulnessPassThreshold?: number;
  citationCoveragePassThreshold?: number;
  /**
   * 可选 LLM judge（对齐 RAGAS faithfulness / context recall）。
   * 不传时 runner 走纯 deterministic 基线，行为与旧版本一致（无回归）；
   * 传入时会在每条 case 的指标中追加 llmFaithfulness / llmContextRecall 校准信号。
   * 允许为 null（如 createLlmJudge 在 provider 禁用时返回 null），等价不传。
   */
  judge?: LlmJudge | null;
}

/**
 * 评测 runner 输出，包含报告、原始结果和运行摘要。
 */
export interface RagEvalRunnerOutput {
  report: RagEvalReportDto;
  results: RagEvalRunResult[];
  durationMs: number;
}

/**
 * 中间答案上下文，保存从 runtime 取回的回答和检索摘要，便于指标函数独立计算。
 */
export interface RagEvalAnswerContext {
  question: string;
  answer: RagAnswer;
  topRetrievedChunkIds: string[];
  topRetrievedDocumentIds: string[];
}

/**
 * 结构化错误，runner 把内部异常收敛为有限错误码。
 */
export interface RagEvalError {
  code: "invalid_case" | "runtime_failed" | "runner_failed";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * runner 结果使用 ok/error union，避免把 RAG runtime 内部异常泄漏到调用方。
 */
export type RagEvalRunnerResult =
  | {
      ok: true;
      output: RagEvalRunnerOutput;
    }
  | {
      ok: false;
      error: RagEvalError;
    };
