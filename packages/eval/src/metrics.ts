import type { EvalMetricDto, RagAnswerDto } from "@aiagent/types";
import type { RagEvalAnswerContext, RagEvalCase, RagEvalRunnerOptions } from "./types.js";

const DEFAULT_RETRIEVAL_PASS_THRESHOLD = 1;
const DEFAULT_CORRECTNESS_PASS_THRESHOLD = 0.5;
const DEFAULT_FAITHFULNESS_PASS_THRESHOLD = 0.4;
const DEFAULT_CITATION_COVERAGE_PASS_THRESHOLD = 0.5;

const STOPWORDS = new Set([
  "公司",
  "的",
  "了",
  "是",
  "和",
  "与",
  "或",
  "在",
  "为",
  "有",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
  "这些",
  "那些",
  "一个",
  "一些",
  "什么",
  "怎么",
  "如何",
  "多少",
  "是否",
  "可以",
  "已经",
  "现在",
  "当时",
  "目前",
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "as",
  "and",
  "or",
  "but",
  "not",
  "no",
  "this",
  "that",
  "these",
  "those"
]);

/**
 * 计算单条 case 的四个 RAG 评测指标。
 *
 * 第一版全部使用 deterministic rubric，不调用 LLM judge，目的是让指标可解释、
 * 可复现、不依赖 API key；局限是 correctness/faithfulness 只能做关键词级近似，
 * 无法像人工或模型 judge 那样理解语义等价和同义改写。
 *
 * @param evalCase 评测用例。
 * @param context 从 RAG runtime 得到的回答与检索上下文。
 * @param options runner 选项，可调整通过阈值。
 * @returns 四个指标列表。
 */
export function computeRagMetrics(
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext,
  options: RagEvalRunnerOptions = {}
): EvalMetricDto[] {
  return [
    computeRetrievalHitRate(evalCase, context, options),
    computeAnswerCorrectness(evalCase, context, options),
    computeFaithfulness(evalCase, context, options),
    computeCitationCoverage(evalCase, context, options)
  ];
}

/**
 * 计算 retrieval hit rate：期望文档或 chunk 是否进入 topK。
 *
 * 优先级：如果 `expectedChunkIds` 存在，检查 chunk-level 命中；
 * 否则检查 `requiredDocumentIds` 中文档是否被召回；
 * 两者都没有时认为没有约束，默认通过。
 *
 * @param evalCase 评测用例。
 * @param context 检索上下文。
 * @param options runner 选项。
 * @returns retrieval hit rate 指标。
 */
function computeRetrievalHitRate(
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext,
  options: RagEvalRunnerOptions
): EvalMetricDto {
  const threshold = options.retrievalPassThreshold ?? DEFAULT_RETRIEVAL_PASS_THRESHOLD;
  const retrievedChunkIds = context.topRetrievedChunkIds;
  const retrievedDocumentIds = context.topRetrievedDocumentIds;

  let score = 1;
  let details = "未指定期望召回文档或来源，默认通过。";

  if (evalCase.expectedChunkIds && evalCase.expectedChunkIds.length > 0) {
    const hits = evalCase.expectedChunkIds.filter((chunkId) => retrievedChunkIds.includes(chunkId));
    score = hits.length / evalCase.expectedChunkIds.length;
    details = `期望 chunk ${evalCase.expectedChunkIds.length} 个，命中 ${hits.length} 个；召回 chunk ids: [${retrievedChunkIds.join(", ") || "无"}]`;
  } else if (evalCase.requiredDocumentIds && evalCase.requiredDocumentIds.length > 0) {
    const hits = evalCase.requiredDocumentIds.filter((documentId) => retrievedDocumentIds.includes(documentId));
    score = hits.length / evalCase.requiredDocumentIds.length;
    details = `期望文档 ${evalCase.requiredDocumentIds.length} 个，命中 ${hits.length} 个；召回文档 ids: [${retrievedDocumentIds.join(", ") || "无"}]`;
  } else if (evalCase.requiredSources && evalCase.requiredSources.length > 0) {
    const hits = evalCase.requiredSources.filter((source) => context.answer.retrievalResults.some((result) => result.citation.source === source));
    score = hits.length / evalCase.requiredSources.length;
    details = `期望来源 ${evalCase.requiredSources.length} 个，命中 ${hits.length} 个；召回来源: [${[...new Set(context.answer.retrievalResults.map((result) => result.citation.source))].join(", ") || "无"}]`;
  }

  return {
    name: "retrievalHitRate",
    score: roundScore(score),
    passed: score >= threshold,
    details
  };
}

/**
 * 计算 answer correctness：答案是否覆盖期望回答要点。
 *
 * 第一版基于 `expectedKeywords` 在答案中的覆盖率打分；
 * 如果没有指定关键词，则基于 `expectedAnswer` 与答案的共有词重叠度打分；
 * 两者都没有时默认通过。
 *
 * @param evalCase 评测用例。
 * @param context 回答上下文。
 * @param options runner 选项。
 * @returns answer correctness 指标。
 */
function computeAnswerCorrectness(
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext,
  options: RagEvalRunnerOptions
): EvalMetricDto {
  const threshold = options.correctnessPassThreshold ?? DEFAULT_CORRECTNESS_PASS_THRESHOLD;
  const answerText = context.answer.answer;

  let score = 1;
  let details = "未指定期望关键词或答案，默认通过。";

  if (evalCase.expectedKeywords && evalCase.expectedKeywords.length > 0) {
    const normalizedAnswer = normalizeText(answerText);
    const hits = evalCase.expectedKeywords.filter((keyword) => normalizedAnswer.includes(normalizeText(keyword)));
    score = hits.length / evalCase.expectedKeywords.length;
    details = `期望关键词 ${evalCase.expectedKeywords.length} 个，命中 ${hits.length} 个：${hits.join("、") || "无"}`;
  } else if (evalCase.expectedAnswer) {
    const answerTerms = extractMeaningfulTerms(answerText);
    const expectedTerms = extractMeaningfulTerms(evalCase.expectedAnswer);
    const expectedTermsArray = [...expectedTerms];
    const hits = expectedTermsArray.filter((term) => answerTerms.has(term));
    score = expectedTermsArray.length > 0 ? hits.length / expectedTermsArray.length : 1;
    details = `期望答案要点词 ${expectedTermsArray.length} 个，命中 ${hits.length} 个：${hits.join("、") || "无"}`;
  }

  return {
    name: "answerCorrectness",
    score: roundScore(score),
    passed: score >= threshold,
    details
  };
}

/**
 * 计算 faithfulness：答案中的关键信息能否被 citations 支撑。
 *
 * 第一版把答案拆成有意义词元，检查这些词元在 citation 对应 chunk quote 中的覆盖比例。
 * 这是一种宽松的 deterministic proxy：只要 citation 文本包含答案中的关键词，就认为该信息有来源支撑。
 * 它无法识别语义等价改写，也无法判断逻辑推理是否合理，只用于发现“答案凭空出现”的明显幻觉。
 *
 * @param evalCase 评测用例。
 * @param context 回答与引用上下文。
 * @param options runner 选项。
 * @returns faithfulness 指标。
 */
function computeFaithfulness(
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext,
  options: RagEvalRunnerOptions
): EvalMetricDto {
  const threshold = options.faithfulnessPassThreshold ?? DEFAULT_FAITHFULNESS_PASS_THRESHOLD;
  const answerText = context.answer.answer;
  const citations = context.answer.citations;

  if (citations.length === 0) {
    return {
      name: "faithfulness",
      score: 0,
      passed: false,
      details: "答案没有任何 citation，无法验证忠实性。"
    };
  }

  const answerTerms = extractMeaningfulTerms(answerText);
  const citedText = citations.map((citation) => `${citation.heading ?? ""} ${citation.quote}`).join(" ");
  const citedTerms = extractMeaningfulTerms(citedText);

  if (answerTerms.size === 0) {
    return {
      name: "faithfulness",
      score: 1,
      passed: true,
      details: "答案没有可提取的有效词元，默认认为忠实。"
    };
  }

  const hits = [...answerTerms].filter((term) => citedTerms.has(term));
  const score = hits.length / answerTerms.size;

  return {
    name: "faithfulness",
    score: roundScore(score),
    passed: score >= threshold,
    details: `答案词元 ${answerTerms.size} 个，被 citations 支撑 ${hits.length} 个：${hits.slice(0, 8).join("、") || "无"}`
  };
}

/**
 * 计算 citation coverage：关键结论是否有引用。
 *
 * 第一版综合两个信号：
 * 1. citation 数量是否达到 `minCitations` 要求；
 * 2. 答案中的关键词是否被 retrieval results 覆盖（而不仅是 citation quotes），
 *    因为当前 citation quote 可能被截断，导致关键词匹配不到。
 *
 * @param evalCase 评测用例。
 * @param context 回答与引用上下文。
 * @param options runner 选项。
 * @returns citation coverage 指标。
 */
function computeCitationCoverage(
  evalCase: RagEvalCase,
  context: RagEvalAnswerContext,
  options: RagEvalRunnerOptions
): EvalMetricDto {
  const threshold = options.citationCoveragePassThreshold ?? DEFAULT_CITATION_COVERAGE_PASS_THRESHOLD;
  const citations = context.answer.citations;
  const retrievalResults = context.answer.retrievalResults;

  const minCitations = evalCase.minCitations ?? 1;
  const citationCountScore = citations.length >= minCitations ? 1 : citations.length / minCitations;

  const answerTerms = extractMeaningfulTerms(context.answer.answer);
  const retrievalText = retrievalResults.map((result) => `${result.citation.heading ?? ""} ${result.text}`).join(" ");
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
    passed: score >= threshold,
    details: `citations ${citations.length}/${minCitations}，答案词元被 retrieval results 覆盖 ${(termCoverage * 100).toFixed(0)}%`
  };
}

/**
 * 提取文本中有意义的词元，用于 deterministic 指标计算。
 *
 * 目前只过滤常见停用词和过短词，后续可替换为分词或 LLM judge。
 *
 * @param text 输入文本。
 * @returns 词元集合。
 */
function extractMeaningfulTerms(text: string): Set<string> {
  const normalized = normalizeText(text);
  const tokens = normalized.split(/[^\u4e00-\u9fa5a-z0-9]+/);

  return new Set(
    tokens.filter((token) => {
      if (token.length === 0) return false;
      if (STOPWORDS.has(token)) return false;
      if (/^[0-9]+$/.test(token) && token.length <= 2) return false;
      return token.length >= 2 || /^[a-z0-9]{2,}$/.test(token);
    })
  );
}

/**
 * 规范化文本，用于大小写不敏感的关键词匹配。
 *
 * @param text 原始文本。
 * @returns 小写并压缩空白的文本。
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 将分数保留三位小数，避免浮点误差导致报告可读性差。
 *
 * @param score 原始分数。
 * @returns 保留三位小数的分数。
 */
function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
