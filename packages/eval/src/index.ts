import type { RagAnswer } from "@aiagent/rag";
import type { EvalCaseDto, EvalMetricDto, EvalResultDto } from "@aiagent/types";
import { DEMO_DOCUMENTS, RAG_EVAL_CASES, createDemoRagRuntime } from "./cases.js";
import { computeRagMetrics, type LlmJudgeResult } from "./metrics.js";
import { createRagEvalReport, runRagEval, runRagEvalWithJudge } from "./runner.js";
import { createLlmJudge, type ContextRecallJudgement, type FaithfulnessJudgement, type LlmJudge, type LlmJudgeOptions } from "./judge.js";
import type {
  RagEvalAnswerContext,
  RagEvalCase,
  RagEvalError,
  RagEvalMetrics,
  RagEvalRunnerInput,
  RagEvalRunnerOptions,
  RagEvalRunnerOutput,
  RagEvalRunnerResult
} from "./types.js";

export type EvalCase = EvalCaseDto;
export type EvalMetric = EvalMetricDto;
export type EvalResult = EvalResultDto;

export type {
  RagEvalCase,
  RagEvalAnswerContext,
  RagEvalMetrics,
  RagEvalRunnerInput,
  RagEvalRunnerOptions,
  RagEvalRunnerOutput,
  RagEvalRunnerResult,
  RagEvalError
};

export type { LlmJudge, LlmJudgeOptions, LlmJudgeResult, FaithfulnessJudgement, ContextRecallJudgement };

export {
  createRagEvalReport,
  runRagEval,
  runRagEvalWithJudge,
  computeRagMetrics,
  createLlmJudge,
  RAG_EVAL_CASES,
  DEMO_DOCUMENTS,
  createDemoRagRuntime
};
export * from "./automation.js";
export {
  runLoopEval,
  runEvalCaseWithLoop,
  LOOP_EVAL_BUDGETS,
  type LoopEvalBudget,
  type LoopEvalCaseRun,
  type LoopEvalOptions,
  type LoopEvalRunEvent,
} from "./loop-runner.js";
export { projectRunEvents } from "./loop-projection.js";
export {
  extractToolTrajectory,
  matchTrajectory,
  deriveExpectedTrajectory,
  classifyFailure,
  type ToolCallStep,
  type TrajectoryExpectation,
  type TrajectoryMatchMode,
  type TrajectoryMatchResult,
  type FailureCategory
} from "./trajectory.js";
export {
  createLoopLlmJudge,
  type LoopLlmJudge,
  type LoopLlmJudgeOptions,
  type JudgeScore
} from "./judge-loop.js";

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
  runtimeState: "runner_and_cases_ready";
}

/**
 * 创建 eval package 的边界摘要，说明本阶段已实现 case、runner、指标和报告。
 *
 * @returns eval package 的职责边界和当前实现状态。
 */
export function createEvalPackageSummary(): EvalPackageSummary {
  return {
    packageName: "@aiagent/eval",
    boundary: "rag_eval_cases_metrics_reports",
    runtimeState: "runner_and_cases_ready"
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
