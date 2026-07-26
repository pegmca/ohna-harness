import {
  type Citation,
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
    quote: createQuote(result.chunk.text),
    pageNumber: result.chunk.pageNumber ?? result.chunk.page,
    confidence: result.scoreBreakdown.finalScore
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
 * @param input 回答文本、检索结果和引用列表。
 * @returns 标准 RAG answer 结构。
 */
export function createRagAnswer(input: {
  answer: string;
  citations: Citation[];
  retrievalResults: RetrievalResult[];
}): RagAnswer {
  return {
    answer: input.answer,
    citations: [...input.citations],
    retrievalResults: [...input.retrievalResults]
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
 * @param question 用户问题。
 * @param results 检索结果。
 * @returns 带 citations 和 retrieval results 的 RAG answer。
 */
export function synthesizeRagAnswer(question: string, results: readonly RetrievedChunk[]): RagAnswer {
  const retrievalResults = results.map(createRetrievalResultFromRetrievedChunk);
  const contentResults = results.filter((result) => !isHeadingOnlyChunk(result.chunk));
  const sufficientResults = contentResults.filter(isEvidenceSufficient);

  if (sufficientResults.length === 0) {
    return createRagAnswer({
      answer: `当前资料不足，无法可靠回答“${question.trim()}”。请先 ingest 包含该问题信息的 Markdown/TXT 文档，或换一个与现有资料更匹配的问题。`,
      citations: retrievalResults.slice(0, 2).map((result) => result.citation),
      retrievalResults
    });
  }

  const citations = sufficientResults.map(createCitationFromRetrievedChunk);
  const evidenceLines = sufficientResults.slice(0, 3).map((result, index) => {
    const heading = result.chunk.heading ? `${result.chunk.heading}：` : "";

    return `[${index + 1}] ${heading}${createAnswerSentence(result.chunk.text, result.scoreBreakdown.matchedTerms)}`;
  });

  return createRagAnswer({
    answer: `基于当前已 ingest 资料，可以得到以下摘要：\n${evidenceLines.join("\n")}`,
    citations,
    retrievalResults
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
 * @param result 检索结果。
 * @returns 相关性足够时返回 true。
 */
function isEvidenceSufficient(result: RetrievedChunk): boolean {
  const hasMeaningfulTerm = result.scoreBreakdown.matchedTerms.some(
    (term) => term.length > 1 && !["公司", "如何", "多少", "是什么"].includes(term)
  );

  return hasMeaningfulTerm && (result.scoreBreakdown.queryTermCoverage >= 0.15 || result.scoreBreakdown.finalScore >= 0.42);
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
 * 截取 citation quote，避免 UI 中引用片段过长。
 *
 * @param text chunk 原文。
 * @returns citation 引文片段。
 */
function createQuote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}
