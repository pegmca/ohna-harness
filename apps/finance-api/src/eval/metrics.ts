/**
 * finance-api 金融 RAG 评测指标（v2.0 评测体系 Step 3，领域自治方案 §3.3）。
 *
 * 本模块是金融 RAG 评测的「领域语义层」：把一条 case + 真实 runtime 产出的 `RagAnswer`
 * 投影成若干确定性指标。它**只认识 `RagAnswer` 与金融 case 字段**，不依赖任何执行器、
 * 不认识 `DataSourceRuntime`、不 import `@aiagent/eval`（旧包）。
 *
 * 指标清单（与 docs/v2.0/02-eval-system-v2.md §3.3 对齐）：
 * - retrievalHitRate：期望 source / document 的命中率（document 级，砍掉 expectedChunkIds）。
 * - MRR：期望命中文档在 retrievalResults 中的倒数排名（document 级）。
 * - NDCG：document 级 rank + score 的归一化折损累计增益。
 * - citationCoverage：citations >= minCitations 且证据覆盖（合并原 deterministic faithfulness）。
 * - answerCorrectness：expectedKeywords 在 answer 文本中的覆盖率。
 * - refusalRate：answer.status === "insufficient_evidence" 的占比（来自 RagAnswerDto.status 前置修正 #1）。
 *
 * 修 G5：每个指标函数返回 `{ name, score, applicable }`；`applicable=false`（无期望字段）的
 * 指标不参与 `aggregateToReport` 的聚合与门禁。
 */

import type { RagAnswer, RetrievalResult } from "@aiagent/rag";
import type { EvalCaseOutcome, EvalMetricValue, EvalReportDto } from "@aiagent/types";
import { extractMeaningfulTerms, normalizeText, roundScore } from "./metrics-text.js";

/**
 * 金融评测 case 投影（仅本指标函数所需字段，避免与 dataset.ts 强耦合）。
 *
 * 这是 metrics.ts 对「什么样的 case 才足以算某项指标」的最小契约；dataset.ts 导出的
 * `FinanceEvalCase` 必须提供这些字段（可选字段缺省表示「该项指标不适用」）。
 */
export interface FinanceEvalCaseLike {
  /** case 唯一 id。 */
  id: string;
  /** 期望命中的来源（source 级约束；与 expectedDocumentIds 至少其一有值时 retrievalHitRate/MRR/NDCG 适用）。 */
  expectedSources?: readonly string[];
  /** 期望命中的文档（document 级约束，可选；缺省回退到 source 命中）。 */
  expectedDocumentIds?: readonly string[];
  /** 答案应覆盖的关键词（answerCorrectness 适用；缺省不适用）。 */
  expectedKeywords?: readonly string[];
  /** citation 数量下限（citationCoverage 适用；缺省 1）。 */
  minCitations?: number;
}

/**
 * 单指标计算结果（内部中间形态）。
 *
 * `applicable` 缺省 `true`；为 `false` 时该指标不参与聚合与门禁（修 G5）。
 */
export interface MetricScore {
  /** 指标名（与 EvalReportDto.metrics[].name 对齐）。 */
  name: string;
  /** 归一化到 [0,1] 的指标得分。 */
  score: number;
  /** 是否计入聚合与门禁；缺省 true（修 G5）。 */
  applicable?: boolean;
}

/** 单条 case 的评测输出：case id、逐指标得分与是否通过。 */
export interface ScoredCase {
  /** case 唯一 id。 */
  id: string;
  /** 逐指标得分（含 applicable 标记）。 */
  metrics: MetricScore[];
  /** 该 case 是否整体通过（所有 applicable 指标均 passed）。 */
  passed: boolean;
  /** 失败的指标名（applicable 指标中未通过者）；空数组表示通过。 */
  failedMetrics: string[];
}

/** 默认 citation 数量下限。 */
const DEFAULT_MIN_CITATIONS = 1;
/** retrievalHitRate / MRR / NDCG 的通过阈值：要求期望集完全命中（score >= 1）。 */
const RETRIEVAL_PERFECT_THRESHOLD = 1;
/** citationCoverage 的通过阈值（合并原 deterministic faithfulness 语义）。 */
const DEFAULT_CITATION_COVERAGE_PASS_THRESHOLD = 0.5;
/** answerCorrectness 的通过阈值。 */
const DEFAULT_CORRECTNESS_PASS_THRESHOLD = 0.5;


/**
 * 从 retrievalResults 去重出"命中来源"集合（以 citation.source 为准）。
 *
 * @param retrievalResults 检索结果列表。
 * @returns 去重后的来源集合。
 */
function collectRetrievedSources(retrievalResults: readonly RetrievalResult[]): Set<string> {
  return new Set(retrievalResults.map((result) => result.citation.source));
}

/**
 * 从 retrievalResults 去重出"命中文档"集合（以 citation.documentId 为准）。
 *
 * @param retrievalResults 检索结果列表。
 * @returns 去重后的文档集合。
 */
function collectRetrievedDocumentIds(retrievalResults: readonly RetrievalResult[]): Set<string> {
  return new Set(retrievalResults.map((result) => result.citation.documentId));
}

/**
 * 计算 retrievalHitRate：期望 source / document 在检索结果中的命中率（document 级）。
 *
 * 优先级：若 `expectedDocumentIds` 有值则按文档命中；否则若 `expectedSources` 有值则按来源命中；
 * 二者皆空时 `applicable=false`（无期望字段，不进聚合/门禁，修 G5）。
 *
 * @param evalCase 金融评测 case。
 * @param retrievalResults 真实 runtime 的检索结果。
 * @returns 命中率指标。
 */
export function retrievalHitRate(
  evalCase: FinanceEvalCaseLike,
  retrievalResults: readonly RetrievalResult[]
): MetricScore {
  const expectedDocuments = evalCase.expectedDocumentIds;
  const expectedSources = evalCase.expectedSources;

  if (expectedDocuments && expectedDocuments.length > 0) {
    const retrieved = collectRetrievedDocumentIds(retrievalResults);
    const hits = expectedDocuments.filter((documentId) => retrieved.has(documentId));
    return {
      name: "retrievalHitRate",
      score: roundScore(hits.length / expectedDocuments.length),
      applicable: true
    };
  }

  if (expectedSources && expectedSources.length > 0) {
    const retrieved = collectRetrievedSources(retrievalResults);
    const hits = expectedSources.filter((source) => retrieved.has(source));
    return {
      name: "retrievalHitRate",
      score: roundScore(hits.length / expectedSources.length),
      applicable: true
    };
  }

  // 无期望字段：不适用，不进聚合/门禁。
  return { name: "retrievalHitRate", score: 1, applicable: false };
}

/**
 * 计算 MRR：期望命中文档/来源在 retrievalResults 中的倒数排名（document 级）。
 *
 * 取所有期望目标中"最佳 rank"（rank 最小者）计算 MRR = 1 / bestRank；无任何命中时为 0。
 * 期望字段缺失时 `applicable=false`。
 *
 * @param evalCase 金融评测 case。
 * @param retrievalResults 真实 runtime 的检索结果（已按 rank 排序）。
 * @returns MRR 指标。
 */
export function mrr(
  evalCase: FinanceEvalCaseLike,
  retrievalResults: readonly RetrievalResult[]
): MetricScore {
  const expectedDocuments = evalCase.expectedDocumentIds;
  const expectedSources = evalCase.expectedSources;

  if ((!expectedDocuments || expectedDocuments.length === 0) && (!expectedSources || expectedSources.length === 0)) {
    return { name: "mrr", score: 1, applicable: false };
  }

  // 以 (documentId|source) 为命中键集合；优先 document 级，回退 source 级。
  const keys = expectedDocuments && expectedDocuments.length > 0
    ? new Set(expectedDocuments)
    : new Set(expectedSources);
  const useDocument = expectedDocuments && expectedDocuments.length > 0;

  let bestRank: number | null = null;
  retrievalResults.forEach((result, index) => {
    // rank 为可选字段；缺失时以数组位置（1-based）兜底，保持确定性。
    const rank = result.rank ?? index + 1;
    const key = useDocument ? result.citation.documentId : result.citation.source;
    if (keys.has(key) && (bestRank === null || rank < bestRank)) {
      bestRank = rank;
    }
  });

  const score = bestRank === null ? 0 : 1 / bestRank;
  return { name: "mrr", score: roundScore(score), applicable: true };
}

/**
 * 计算 NDCG：document 级 rank + score 的归一化折损累计增益。
 *
 * 理想排序（IDCG）按期望命中目标的 score 降序排列（同分按 rank 自然序）；实际 DCG 按
 * retrievalResults 的 rank 取命中级增益 = (2^score - 1) / log2(rank + 1)。NDCG = DCG / IDCG。
 * 期望字段缺失时 `applicable=false`。
 *
 * @param evalCase 金融评测 case。
 * @param retrievalResults 真实 runtime 的检索结果（已按 rank 排序）。
 * @returns NDCG 指标。
 */
export function ndcg(
  evalCase: FinanceEvalCaseLike,
  retrievalResults: readonly RetrievalResult[]
): MetricScore {
  const expectedDocuments = evalCase.expectedDocumentIds;
  const expectedSources = evalCase.expectedSources;

  if ((!expectedDocuments || expectedDocuments.length === 0) && (!expectedSources || expectedSources.length === 0)) {
    return { name: "ndcg", score: 1, applicable: false };
  }

  const keys = expectedDocuments && expectedDocuments.length > 0
    ? new Set(expectedDocuments)
    : new Set(expectedSources);
  const useDocument = expectedDocuments && expectedDocuments.length > 0;

  // 每个期望 key 可能命中多个 chunk（同一文档被切块）；NDCG 必须按 key 去重、只取
  // 「最优候选」（rank 最小优先、同 rank 取 score 最高），否则 DCG 会重复累加、出现 >1 异常。
  interface Hit {
    rank: number;
    score: number;
  }
  const bestByKey = new Map<string, Hit>();
  retrievalResults.forEach((result, index) => {
    const key = useDocument ? result.citation.documentId : result.citation.source;
    if (!keys.has(key)) return;
    // rank 为可选字段；缺失时以数组位置（1-based）兜底，保持确定性。
    const rank = result.rank ?? index + 1;
    const score = result.score;
    const existing = bestByKey.get(key);
    if (!existing || rank < existing.rank || (rank === existing.rank && score > existing.score)) {
      bestByKey.set(key, { rank, score });
    }
  });

  // 真实 DCG：对每个命中期望 key 累加增益（已去重为单候选）。
  let dcg = 0;
  for (const hit of bestByKey.values()) {
    dcg += (Math.pow(2, hit.score) - 1) / Math.log2(hit.rank + 1);
  }

  // 理想 IDCG：把所有命中 key 的实际 score 降序排在 1..K 的自然 rank 上。
  // 未命中的期望 key 不在 bestByKey 中（score=0），不贡献增益，故 NDCG 恒 ≤ 1。
  const bestScores = [...bestByKey.values()].map((hit) => hit.score).sort((left, right) => right - left);
  let idcg = 0;
  bestScores.forEach((score, index) => {
    const rank = index + 1;
    idcg += (Math.pow(2, score) - 1) / Math.log2(rank + 1);
  });

  const score = idcg === 0 ? 0 : dcg / idcg;
  return { name: "ndcg", score: roundScore(score), applicable: true };
}

/**
 * 计算 citationCoverage：citations 数量达标且答案证据被检索结果覆盖。
 *
 * 合并原 deterministic faithfulness 语义——既看 citation 数量是否达 `minCitations`，
 * 也看 answer 中的有意义词元是否被 retrievalResults（而非仅被截断的 quote）覆盖，
 * 从而既能发现"无引用幻觉"，也能发现"引用了但检索结果未支撑答案要点"的弱忠实。
 *
 * 恒定适用（即使无期望字段也反映答案 grounding 质量），故 `applicable=true`。
 *
 * @param evalCase 金融评测 case。
 * @param answer 真实 runtime 产出的 RAG answer。
 * @returns citation coverage 指标。
 */
export function citationCoverage(
  evalCase: FinanceEvalCaseLike,
  answer: RagAnswer
): MetricScore {
  const citations = answer.citations;
  const retrievalResults = answer.retrievalResults;
  const minCitations = evalCase.minCitations ?? DEFAULT_MIN_CITATIONS;

  // 信号 1：citation 数量是否达标（比例封顶 1）。
  const citationCountScore = citations.length >= minCitations ? 1 : citations.length / minCitations;

  // 信号 2：答案词元被 retrieval results 覆盖比例（避免 quote 截断导致的漏匹配）。
  const answerTerms = extractMeaningfulTerms(answer.answer);
  const retrievalText = retrievalResults
    .map((result) => `${result.citation.heading ?? ""} ${result.text}`)
    .join(" ");
  const retrievalTerms = extractMeaningfulTerms(retrievalText);

  let termCoverage = 1;
  if (answerTerms.size > 0) {
    const covered = [...answerTerms].filter((term) => retrievalTerms.has(term)).length;
    termCoverage = covered / answerTerms.size;
  }

  const score = citationCountScore * termCoverage;
  return {
    name: "citationCoverage",
    score: roundScore(score),
    applicable: true
  };
}

/**
 * 计算 answerCorrectness：expectedKeywords 在 answer 文本中的覆盖率。
 *
 * 关键词级近似（语义等价靠 judge，本指标不进门禁校准之外的语义判断）。
 * 无 `expectedKeywords` 时 `applicable=false`。
 *
 * @param evalCase 金融评测 case。
 * @param answer 真实 runtime 产出的 RAG answer。
 * @returns answer correctness 指标。
 */
export function answerCorrectness(
  evalCase: FinanceEvalCaseLike,
  answer: RagAnswer
): MetricScore {
  const expectedKeywords = evalCase.expectedKeywords;

  if (!expectedKeywords || expectedKeywords.length === 0) {
    return { name: "answerCorrectness", score: 1, applicable: false };
  }

  const normalizedAnswer = normalizeText(answer.answer);
  const hits = expectedKeywords.filter((keyword) => normalizedAnswer.includes(normalizeText(keyword)));
  return {
    name: "answerCorrectness",
    score: roundScore(hits.length / expectedKeywords.length),
    applicable: true
  };
}

/**
 * 计算单条 case 的全部确定性指标（不含 judge 校准信号）。
 *
 * 统一入口：dataset 工作项 / run 工作项调用本函数得到逐指标得分，再交给
 * `aggregateToReport` 聚合。所有指标函数均纯同步、零外部依赖，便于确定性复现。
 *
 * @param evalCase 金融评测 case（最小投影）。
 * @param answer 真实 runtime 产出的 RAG answer。
 * @returns 逐指标得分列表。
 */
export function scoreCaseWithEvidence(
  evalCase: FinanceEvalCaseLike,
  answer: RagAnswer
): MetricScore[] {
  const retrievalResults = answer.retrievalResults;
  return [
    retrievalHitRate(evalCase, retrievalResults),
    mrr(evalCase, retrievalResults),
    ndcg(evalCase, retrievalResults),
    citationCoverage(evalCase, answer),
    answerCorrectness(evalCase, answer)
  ];
}

/** 单指标通过阈值表（applicable 指标的 pass 判定）。 */
const METRIC_PASS_THRESHOLDS: Record<string, number> = {
  retrievalHitRate: RETRIEVAL_PERFECT_THRESHOLD,
  mrr: 0,
  ndcg: 0,
  citationCoverage: DEFAULT_CITATION_COVERAGE_PASS_THRESHOLD,
  answerCorrectness: DEFAULT_CORRECTNESS_PASS_THRESHOLD
};

/**
 * 判断单指标得分是否通过（仅对 applicable 指标有效）。
 *
 * @param metric 指标得分。
 * @returns 通过与否。
 */
function isMetricPassed(metric: MetricScore): boolean {
  const threshold = METRIC_PASS_THRESHOLDS[metric.name];
  if (threshold === undefined) {
    // 未知指标默认宽松通过，避免误拦；新增指标应在阈值表登记。
    return true;
  }
  return metric.score >= threshold;
}

/**
 * 把单条 case 的指标得分收敛为 `ScoredCase`（含 passed / failedMetrics）。
 *
 * `passed` = 所有 applicable 指标均 passed；`failedMetrics` 承载失败指标名（修 RAG 归因丢失）。
 *
 * @param evalCase 金融评测 case（仅需 id）。
 * @param metrics 逐指标得分。
 * @returns 收敛后的 scored case。
 */
export function evaluateCaseOutcome(
  evalCase: { id: string },
  metrics: MetricScore[]
): ScoredCase {
  const applicableMetrics = metrics.filter((metric) => metric.applicable !== false);
  const failedMetrics = applicableMetrics
    .filter((metric) => !isMetricPassed(metric))
    .map((metric) => metric.name);
  const passed = failedMetrics.length === 0;

  return {
    id: evalCase.id,
    metrics,
    passed,
    failedMetrics
  };
}

/**
 * 把逐 case 指标聚合为 `EvalReportDto`（落实前置修正 #3 + 修 G5）。
 *
 * 聚合契约：
 * - `metrics[].value` = 该指标跨 case 的**聚合均值**（仅对 applicable 项求平均，修 G5）；
 *   某指标在所有 case 均 `applicable=false` 时，写 `applicable=false` 且 value=0，不进分母/门禁。
 * - `cases[].passed` = `metrics.every(m => m.passed)`（所有 applicable 指标 passed）；
 * - `cases[].failedMetrics` = 失败指标名（修 RAG 归因丢失）。
 *
 * @param target 被测目标标识（如 "finance-api"）。
 * @param dataset 数据集标识（如 "rag-v1"）。
 * @param scoredCases 逐 case 的评分结果（id + 逐指标得分 + passed/failedMetrics）。
 * @returns 聚合后的跨边界报告线格式。
 */
export function aggregateToReport(
  target: string,
  dataset: string,
  scoredCases: ScoredCase[]
): EvalReportDto {
  // 收集所有出现过且 applicable 的指标名（按首次出现顺序，保持稳定报告顺序）。
  const metricNames: string[] = [];
  const applicableByMetric = new Map<string, number[]>();

  for (const scored of scoredCases) {
    for (const metric of scored.metrics) {
      if (!metricNames.includes(metric.name)) {
        metricNames.push(metric.name);
      }
      if (metric.applicable !== false) {
        const bucket = applicableByMetric.get(metric.name) ?? [];
        bucket.push(metric.score);
        applicableByMetric.set(metric.name, bucket);
      }
    }
  }

  const aggregatedMetrics: EvalMetricValue[] = metricNames.map((name) => {
    const values = applicableByMetric.get(name);
    const applicable = values !== undefined && values.length > 0;
    const value = applicable
      ? roundScore(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    return {
      name,
      value,
      unit: "ratio",
      applicable
    };
  });

  const caseOutcomes: EvalCaseOutcome[] = scoredCases.map((scored) => ({
    id: scored.id,
    passed: scored.passed,
    ...(scored.failedMetrics.length > 0 ? { failedMetrics: scored.failedMetrics } : {})
  }));

  return {
    target,
    dataset,
    createdAt: new Date().toISOString(),
    metrics: aggregatedMetrics,
    cases: caseOutcomes
  };
}

/**
 * 计算 refusalRate：答案状态为 insufficient_evidence 的占比（来自 RagAnswerDto.status 前置修正 #1）。
 *
 * 该指标是**跨 case 聚合指标**，不挂在单 case 上（单 case 的是布尔"是否拒答"）。由 run 工作项
 * 收集逐 case 状态后调用本函数得到聚合值，再并入报告 metrics。
 *
 * @param answers 逐 case 的真实 runtime answer（顺序与 cases 对齐）。
 * @returns 拒答率（[0,1]）；无 case 时返回 0。
 */
export function refusalRate(answers: readonly RagAnswer[]): number {
  if (answers.length === 0) return 0;
  const refused = answers.filter((answer) => answer.status === "insufficient_evidence").length;
  return roundScore(refused / answers.length);
}
