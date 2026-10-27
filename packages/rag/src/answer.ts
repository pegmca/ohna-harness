import {
  type Citation,
  type EvidenceSufficiencyThreshold,
  type RagAnswer,
  type RagChunk,
  type RetrievalResult,
  type RetrievedChunk
} from "./types.js";

/**
 * 从检索候选创建可展示 citation，确保回答来源能回到 document、source、heading 和 chunkIndex。
 *
 * @param result 检索命中的 chunk 和分数。
 * @returns 标准 citation DTO。
 */
export function createCitationFromRetrievedChunk(result: RetrievedChunk): Citation {
  return {
    chunkId: result.chunk.chunkId,
    documentId: result.chunk.documentId,
    source: result.chunk.source,
    heading: result.chunk.heading,
    chunkIndex: result.chunk.chunkIndex,
    quote: createCitationText(result.chunk),
    pageNumber: result.chunk.pageNumber ?? result.chunk.page,
    confidence: result.scoreBreakdown.finalScore,
    // 仅在候选带 sourceKind 时才复制，保证旧单源 citation 形状不变（不出现 undefined 键）。
    ...(result.sourceKind !== undefined ? { sourceKind: result.sourceKind } : {})
  };
}

/**
 * 把检索候选投影为 API/UI 可展示的 retrieval result。
 *
 * @param result 检索命中的 chunk 和 score breakdown。
 * @returns 包含 citation 的 retrieval result DTO。
 */
export function createRetrievalResultFromRetrievedChunk(result: RetrievedChunk): RetrievalResult {
  return {
    chunkId: result.chunk.chunkId,
    documentId: result.chunk.documentId,
    score: result.score,
    rank: result.rank,
    text: result.chunk.text,
    scoreBreakdown: result.scoreBreakdown,
    citation: createCitationFromRetrievedChunk(result)
  };
}

/**
 * 从检索结果和引用创建 grounded answer 占位对象，后续会接入真实生成模型。
 *
 * status 为可选项：不传时保持原形状（向后兼容）；传入时透传到 RagAnswer，
 * 用于结构化区分「已回答」与「证据不足拒答」（前置修正 #1，取代 answer 文本魔法字符串）。
 *
 * @param input 回答文本、检索结果、引用列表与可选回答状态。
 * @returns 标准 RAG answer 结构。
 */
export function createRagAnswer(input: {
  answer: string;
  citations: Citation[];
  retrievalResults: RetrievalResult[];
  status?: RagAnswer["status"];
}): RagAnswer {
  return {
    answer: input.answer,
    citations: [...input.citations],
    retrievalResults: [...input.retrievalResults],
    ...(input.status !== undefined ? { status: input.status } : {})
  };
}

/**
 * 根据检索证据生成 deterministic grounded answer。
 *
 * 第一版不调用 LLM，而是把高相关 chunk 摘成简短摘要；当没有足够匹配证据时明确说明资料不足，
 * 用来验证 unknown answer policy 和 citation 数据流。
 *
 * 改进点：
 * - 过滤掉 Markdown 解析产生的 heading-only 块，避免答案中出现“盈利能力：盈利能力”这类无信息条目。
 * - 证据句优先选择包含命中词的最长句子，而不是简单取第一句，提高关键词覆盖和可解释性。
 *
 * v2.0 前置修正 #1：
 * - 两个分支分别打结构化 status：证据不足 → "insufficient_evidence"，否则 → "answered"，
 *   取代原先 answer 文本中的魔法字符串，便于评测与 API 判定拒答；
 * - 充分性阈值 threshold 可注入（minQueryTermCoverage / minFinalScore），缺省沿用常量 0.15 / 0.42，
 *   不传参时行为与原版【完全一致】，实现阈值可观测、可调。
 *
 * @param question 用户问题。
 * @param results 检索结果。
 * @param threshold 证据充分性阈值（可选）；不传时沿用内置常量，行为与旧版一致。
 * @returns 带 citations、retrieval results 与结构化 status 的 RAG answer。
 */
export function synthesizeRagAnswer(
  question: string,
  results: readonly RetrievedChunk[],
  threshold: EvidenceSufficiencyThreshold = {}
): RagAnswer {
  // 内置默认阈值：与原版 isEvidenceSufficient 的判定常量（0.15 / 0.42）保持一致。
  // 仅在调用方显式注入时覆盖，保证默认行为零回归。
  const DEFAULT_THRESHOLD = { minQueryTermCoverage: 0.15, minFinalScore: 0.42 };
  const activeThreshold = {
    minQueryTermCoverage: threshold.minQueryTermCoverage ?? DEFAULT_THRESHOLD.minQueryTermCoverage,
    minFinalScore: threshold.minFinalScore ?? DEFAULT_THRESHOLD.minFinalScore
  };

  const retrievalResults = results.map(createRetrievalResultFromRetrievedChunk);
  const contentResults = results.filter((result) => !isHeadingOnlyChunk(result.chunk));
  const sufficientResults = contentResults.filter((result) => isEvidenceSufficient(result, activeThreshold));

  if (sufficientResults.length === 0) {
    return createRagAnswer({
      answer: `当前资料不足，无法可靠回答“${question.trim()}”。请先 ingest 包含该问题信息的 Markdown/TXT 文档，或换一个与现有资料更匹配的问题。`,
      citations: retrievalResults.slice(0, 2).map((result) => result.citation),
      retrievalResults,
      status: "insufficient_evidence"
    });
  }

  const citations = sufficientResults.map(createCitationFromRetrievedChunk);
  const evidenceLines = sufficientResults.slice(0, 3).map((result, index) => {
    const heading = result.chunk.heading ? `${result.chunk.heading}：` : "";

    return `[${index + 1}] ${heading}${createAnswerEvidence(result.chunk, result.scoreBreakdown.matchedTerms)}`;
  });

  return createRagAnswer({
    answer: `基于当前已 ingest 资料，可以得到以下摘要：\n${evidenceLines.join("\n")}`,
    citations,
    retrievalResults,
    status: "answered"
  });
}

/**
 * 判断 chunk 是否只是 Markdown heading 块，没有实质内容。
 *
 * @param chunk RAG chunk。
 * @returns 是 heading-only 块时返回 true。
 */
function isHeadingOnlyChunk(chunk: RagChunk): boolean {
  if (!chunk.heading) {
    return false;
  }

  const text = chunk.text.trim();
  const heading = chunk.heading.trim();

  return text.length <= heading.length + 5 || text.replace(/[:：\s]/g, "") === heading.replace(/[:：\s]/g, "");
}

/**
 * 判断单条召回结果是否足以进入 answer synthesis。
 *
 * 阈值来自 synthesizeRagAnswer 解析后的 activeThreshold：覆盖率或最终分数任一过线即视为充分，
 * 调用方调高阈值即可把边界样本翻转为拒答（阈值可观测、可调）。
 *
 * @param result 检索结果。
 * @param threshold 生效的充分性阈值（已合并缺省值）。
 * @returns 相关性足够时返回 true。
 */
function isEvidenceSufficient(result: RetrievedChunk, threshold: { minQueryTermCoverage: number; minFinalScore: number }): boolean {
  const hasMeaningfulTerm = result.scoreBreakdown.matchedTerms.some(
    (term) => term.length > 1 && !["公司", "如何", "多少", "是什么"].includes(term)
  );

  return hasMeaningfulTerm && (result.scoreBreakdown.queryTermCoverage >= threshold.minQueryTermCoverage || result.scoreBreakdown.finalScore >= threshold.minFinalScore);
}

/**
 * 截取适合 answer 主体展示的证据句。
 *
 * 优先返回包含命中词的最长句子，命中词为空时回退到第一句；
 * 这样能让答案更有可能覆盖用户查询中的关键词，也便于后续 eval correctness 检查。
 *
 * @param text chunk 原文。
 * @param matchedTerms 检索命中的词，用于选择最有信息量的句子。
 * @returns 短句摘要。
 */
function createAnswerSentence(text: string, matchedTerms: readonly string[] = []): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[。！？!?；;])\s*/u).filter((item) => item.trim().length > 0);

  if (sentences.length === 0) {
    return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
  }

  if (matchedTerms.length === 0) {
    const first = sentences[0] ?? normalized;
    return first.length > 120 ? `${first.slice(0, 120)}...` : first;
  }

  const scoredSentences = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const hitCount = matchedTerms.filter((term) => lower.includes(term.toLowerCase())).length;
    return { sentence, hitCount, length: sentence.length };
  });

  scoredSentences.sort((left, right) => {
    if (right.hitCount !== left.hitCount) {
      return right.hitCount - left.hitCount;
    }

    return right.length - left.length;
  });

  const best = scoredSentences[0]?.sentence ?? normalized;

  return best.length > 120 ? `${best.slice(0, 120)}...` : best;
}

/**
 * 整表 chunk 直接返回全表；普通 chunk 仍走 120 字句子摘要。
 *
 * @param chunk RAG chunk。
 * @param matchedTerms 查询命中词。
 * @returns 可直接进入 answer 的证据文本。
 */
function createAnswerEvidence(chunk: RagChunk, matchedTerms: readonly string[]): string {
  return chunk.metadata.isTableChunk === true ? chunk.text : createAnswerSentence(chunk.text, matchedTerms);
}

/**
 * 整表 chunk 的 citation 保留全表文本；普通 chunk 维持短引文。
 *
 * @param chunk RAG chunk。
 * @returns citation quote。
 */
function createCitationText(chunk: RagChunk): string {
  return chunk.metadata.isTableChunk === true ? chunk.text : createQuote(chunk.text);
}

/**
 * 截取 citation quote，避免 UI 中引用片段过长。
 *
 * @param text chunk 原文。
 * @returns citation 引文片段。
 */
function createQuote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}
