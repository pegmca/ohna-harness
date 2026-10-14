import type { DataSourceRuntime, RagAnswer } from "@aiagent/rag";
import type { EvalResultDto, RagEvalFailureDto, RagEvalReportDto } from "@aiagent/types";
import { computeRagMetrics, type LlmJudgeResult } from "./metrics.js";
import type { LlmJudge } from "./judge.js";
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

const DEFAULT_TOP_K = 5;
const DEFAULT_MODE = "hybrid";

/**
 * RAG eval runner：对每一条 case 调用 RAG runtime 的 answer，计算四个指标并生成报告。
 *
 * 设计要点：
 * - runner 只依赖 `DataSourceRuntime` 接口，不依赖具体 runtime 实现，便于后续替换持久化 runtime。
 * - 每个 case 独立调用 `answer()`，模拟真实用户查询；不缓存上一条结果，保证可复现。
 * - 所有内部异常都被收敛为结构化 `RagEvalError`，避免向调用方泄漏原始异常。
 *
 * @param input 包含 case 集合和已初始化 RAG runtime 的输入。
 * @returns runner 成功时返回报告与原始结果，失败时返回结构化错误。
 */
export async function runRagEval(input: RagEvalRunnerInput): Promise<RagEvalRunnerResult> {
  const startedAt = Date.now();

  try {
    const results: EvalResultDto[] = [];

    for (const evalCase of input.cases) {
      const caseResult = await runSingleCase(evalCase, input.runtime, input.options);
      results.push(caseResult);
    }

    const report = createRagEvalReport(results);
    const output: RagEvalRunnerOutput = {
      report,
      results,
      durationMs: Date.now() - startedAt
    };

    return { ok: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evalError: RagEvalError = {
      code: "runner_failed",
      message: `eval runner 执行失败：${message}`,
      details: { cause: error instanceof Error ? error.stack : undefined }
    };

    return { ok: false, error: evalError };
  }
}

/**
 * 带 LLM judge 的 RAG eval 入口（演示用，默认路径 runRagEval 不受影响）。
 *
 * 内部把传入的 judge 注入 runner 选项；不传 judge 等价于 runRagEval，保证向后兼容。
 *
 * @param input 包含 case 集合和已初始化 RAG runtime 的输入。
 * @param judge 可选 LLM judge 实例；缺省时退化为纯 deterministic 基线。
 * @returns 与 runRagEval 相同的结果结构，并额外携带 judge 校准指标。
 */
export async function runRagEvalWithJudge(
  input: RagEvalRunnerInput,
  judge?: LlmJudge | null
): Promise<RagEvalRunnerResult> {
  const optionsWithJudge: RagEvalRunnerOptions = {
    ...(input.options ?? {}),
    judge: judge ?? undefined
  };

  return runRagEval({
    ...input,
    options: optionsWithJudge
  });
}

/**
 * 运行单条 case，从 RAG runtime 获取答案并计算指标。
 *
 * @param evalCase 评测用例。
 * @param runtime 已初始化的 RAG runtime。
 * @param options runner 选项。
 * @returns 单条 eval result。
 */
async function runSingleCase(
  evalCase: RagEvalCase,
  runtime: DataSourceRuntime,
  options: RagEvalRunnerOptions = {}
): Promise<EvalResultDto> {
  const validationError = validateEvalCase(evalCase);

  if (validationError) {
    return createErrorResult(evalCase, validationError);
  }

  const topK = options.topK ?? DEFAULT_TOP_K;
  const mode = options.mode ?? DEFAULT_MODE;

  const answerResult = await runtime.answer(evalCase.question, { topK, mode });

  if (!answerResult.ok) {
    return createErrorResult(
      evalCase,
      `RAG runtime 回答失败：${answerResult.error.message}`,
      answerResult.error.code
    );
  }

  const answer = answerResult.data.answer;
  const context = createAnswerContext(evalCase.question, answer);

  // judge 是可选校准信号：仅在 options.judge 存在时异步调用，默认路径完全不触网、零回归。
  const judgeResult = options.judge ? await computeJudgeResult(options.judge, evalCase, context) : undefined;
  const metrics = computeRagMetrics(evalCase, context, options, judgeResult);

  return {
    caseId: evalCase.id,
    question: evalCase.question,
    answer,
    expectedAnswer: evalCase.expectedAnswer,
    metrics,
    passed: metrics.every((metric) => metric.passed)
  };
}

/**
 * 异步调用 LLM judge，得到已解析结果快照供 computeRagMetrics 同步追加。
 *
 * judge 的两个判定均自带降级（key 缺失/网络失败返回中性分），这里直接透传，不向上抛。
 *
 * @param judge LLM judge 实例。
 * @param evalCase 评测用例（提供 expectedAnswer/expectedKeywords 作为期望证据来源）。
 * @param context 回答与检索上下文。
 * @returns 已解析的 judge 结果快照。
 */
async function computeJudgeResult(
  judge: LlmJudge,
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext
): Promise<LlmJudgeResult> {
  const retrievedContexts = context.answer.retrievalResults.map((result) => result.text);
  const expectedContexts = [evalCase.expectedAnswer, ...(evalCase.expectedKeywords ?? [])].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  const [faithfulness, contextRecall] = await Promise.all([
    judge.judgeFaithfulness(evalCase.question, context.answer.answer, retrievedContexts),
    judge.judgeContextRecall(expectedContexts, retrievedContexts)
  ]);

  return { faithfulness, contextRecall };
}

/**
 * 从 RAG answer 和检索结果构建指标计算所需的上下文。
 *
 * @param question 用户问题。
 * @param answer RAG runtime 返回的答案。
 * @returns 包含 topK chunk/document id 的上下文。
 */
function createAnswerContext(question: string, answer: RagAnswer): RagEvalAnswerContext {
  const topRetrievedChunkIds = answer.retrievalResults.slice(0, 5).map((result) => result.chunkId);
  const topRetrievedDocumentIds = [...new Set(answer.retrievalResults.slice(0, 5).map((result) => result.documentId))];

  return {
    question,
    answer,
    topRetrievedChunkIds,
    topRetrievedDocumentIds
  };
}

/**
 * 校验 eval case 的最小必填字段。
 *
 * @param evalCase 待校验的 case。
 * @returns 校验失败时返回错误信息，否则返回 undefined。
 */
function validateEvalCase(evalCase: RagEvalCase): string | undefined {
  if (!evalCase.id || evalCase.id.trim().length === 0) {
    return "case id 不能为空";
  }

  if (!evalCase.question || evalCase.question.trim().length === 0) {
    return "case question 不能为空";
  }

  return undefined;
}

/**
 * 把 runner 内部错误转换为一条失败的 eval result，保证报告仍包含该 case。
 *
 * @param evalCase 评测用例。
 * @param message 错误描述。
 * @param code 可选错误码。
 * @returns 失败的 eval result。
 */
function createErrorResult(evalCase: RagEvalCase, message: string, code?: string): EvalResultDto {
  const emptyAnswer: RagAnswer = {
    answer: "",
    citations: [],
    retrievalResults: []
  };

  return {
    caseId: evalCase.id,
    question: evalCase.question,
    answer: emptyAnswer,
    expectedAnswer: evalCase.expectedAnswer,
    metrics: [
      { name: "retrievalHitRate", score: 0, passed: false, details: message },
      { name: "answerCorrectness", score: 0, passed: false, details: message },
      { name: "faithfulness", score: 0, passed: false, details: message },
      { name: "citationCoverage", score: 0, passed: false, details: code ? `code: ${code}` : message }
    ],
    passed: false
  };
}

/**
 * 从逐条结果生成 RAG eval 报告，包括总体指标、失败案例和优化建议。
 *
 * @param results 逐条 eval result。
 * @returns 结构化 eval 报告。
 */
export function createRagEvalReport(results: readonly EvalResultDto[]): RagEvalReportDto {
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const failedCases = totalCases - passedCases;
  const passRate = totalCases > 0 ? passedCases / totalCases : 0;

  const metrics: RagEvalMetrics = {
    totalCases,
    passedCases,
    failedCases,
    passRate: roundScore(passRate),
    retrievalHitRate: averageMetric(results, "retrievalHitRate"),
    answerCorrectness: averageMetric(results, "answerCorrectness"),
    faithfulness: averageMetric(results, "faithfulness"),
    citationCoverage: averageMetric(results, "citationCoverage")
  };

  const failures = collectFailures(results);
  const recommendations = generateRecommendations(metrics, failures);

  return {
    metrics,
    results: [...results],
    failures,
    recommendations
  };
}

/**
 * 计算指定指标在所有结果中的平均值。
 *
 * @param results eval 结果列表。
 * @param metricName 指标名。
 * @returns 平均分数。
 */
function averageMetric(results: readonly EvalResultDto[], metricName: string): number {
  if (results.length === 0) return 0;

  const sum = results.reduce((total, result) => {
    const metric = result.metrics.find((m) => m.name === metricName);
    return total + (metric?.score ?? 0);
  }, 0);

  return roundScore(sum / results.length);
}

/**
 * 收集失败案例，用于报告和后续人工分析。
 *
 * 失败案例只取前 3 个（按 caseId 排序），便于报告聚焦；其余失败可在逐条结果中查看。
 *
 * @param results eval 结果列表。
 * @returns 最多 3 条失败案例分析。
 */
function collectFailures(results: readonly EvalResultDto[]): RagEvalFailureDto[] {
  return results
    .filter((result) => !result.passed)
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .slice(0, 3)
    .map((result) => ({
      caseId: result.caseId,
      question: result.question,
      answerText: result.answer.answer,
      expectedAnswer: result.expectedAnswer,
      retrievedChunkIds: result.answer.retrievalResults.map((r) => r.chunkId),
      citationChunkIds: result.answer.citations.map((c) => c.chunkId),
      failedMetrics: result.metrics.filter((metric) => !metric.passed),
      analysis: inferFailureReason(result)
    }));
}

/**
 * 根据失败的指标推断失败原因，生成可读的改进建议。
 *
 * @param result 单条失败结果。
 * @returns 失败原因分析文本。
 */
function inferFailureReason(result: EvalResultDto): string {
  const failedNames = result.metrics.filter((metric) => !metric.passed).map((metric) => metric.name);
  const reasons: string[] = [];

  if (failedNames.includes("retrievalHitRate")) {
    reasons.push("未召回期望文档或 chunk，可能因 query 与文档表达不一致、topK 过小或索引未包含相关内容。");
  }

  if (failedNames.includes("answerCorrectness")) {
    reasons.push("答案缺少期望关键词，可能因检索证据不足或答案生成策略截断关键信息。");
  }

  if (failedNames.includes("faithfulness")) {
    reasons.push("答案中的关键词未被 citations 支撑，可能存在模型幻觉或 citation quote 截断导致匹配失败。");
  }

  if (failedNames.includes("citationCoverage")) {
    reasons.push("citation 数量不足或关键结论未被 retrieval results 覆盖。");
  }

  return reasons.join(" ") || "未知失败原因，请查看逐条指标详情。";
}

/**
 * 根据总体指标和失败案例生成优化建议。
 *
 * @param metrics 总体指标。
 * @param failures 失败案例分析。
 * @returns 优化建议列表。
 */
function generateRecommendations(
  metrics: RagEvalMetrics,
  failures: readonly RagEvalFailureDto[]
): string[] {
  const recommendations: string[] = [];

  if (metrics.retrievalHitRate < 0.8) {
    recommendations.push("retrieval hit rate 偏低，建议扩充 demo 文档覆盖、调整 hybrid 权重或引入 query 扩展/重写。");
  }

  if (metrics.answerCorrectness < 0.7) {
    recommendations.push("answer correctness 偏低，建议优化答案生成策略（如接入 LLM context packing）或扩展 expected keywords。");
  }

  if (metrics.faithfulness < 0.6) {
    recommendations.push("faithfulness 偏低，建议加强 citation 校验：确保每条关键结论都有对应 chunk quote 支撑，并考虑引入 LLM judge。");
  }

  if (metrics.citationCoverage < 0.6) {
    recommendations.push("citation coverage 偏低，建议在答案合成阶段显式要求模型为每个关键结论生成引用。");
  }

  if (failures.length > 0 && recommendations.length === 0) {
    recommendations.push("总体指标尚可，但存在个别失败 case，建议逐条检查 query、召回结果和答案的匹配关系。");
  }

  if (recommendations.length === 0) {
    recommendations.push("当前指标整体通过，建议持续补充 edge case 并定期回归。");
  }

  return recommendations;
}

/**
 * 将分数保留三位小数。
 *
 * @param score 原始分数。
 * @returns 保留三位小数的分数。
 */
function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
