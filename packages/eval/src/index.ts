import type { RagAnswer } from "@aiagent/rag";
import type { EvalCaseDto, EvalMetricDto, EvalResultDto } from "@aiagent/types";

export type EvalCase = EvalCaseDto;
export type EvalMetric = EvalMetricDto;
export type EvalResult = EvalResultDto;

export interface EvalRunnerInput {
  case: EvalCase;
  answer: RagAnswer;
}

export interface EvalStructuredError {
  code: "invalid_case" | "runner_failed" | "metric_failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface EvalPackageSummary {
  packageName: "@aiagent/eval";
  boundary: "rag_eval_cases_metrics_reports";
  runtimeState: "types_and_mock_only";
}

/**
 * 创建 eval package 的边界摘要，说明本阶段只沉淀评测 contract。
 *
 * @returns eval package 的职责边界和当前实现状态。
 */
export function createEvalPackageSummary(): EvalPackageSummary {
  return {
    packageName: "@aiagent/eval",
    boundary: "rag_eval_cases_metrics_reports",
    runtimeState: "types_and_mock_only"
  };
}

/**
 * 创建最小 RAG 评测结果，供后续 runner 和报告输出复用稳定结构。
 *
 * @param input eval case、RAG answer 和指标列表。
 * @returns 标准 eval result 结构。
 */
export function createEvalResult(input: {
  case: EvalCase;
  answer: RagAnswer;
  metrics: EvalMetric[];
}): EvalResult {
  return {
    caseId: input.case.id,
    question: input.case.question,
    answer: input.answer,
    expectedAnswer: input.case.expectedAnswer,
    metrics: [...input.metrics],
    passed: input.metrics.every((metric) => metric.passed)
  };
}
