import type { PdfEvidenceDocument } from "./evidence.js";

/** 单个作者关键词在扫描文本中的命中摘要。 */
export interface KeywordMatch {
  keyword: string;
  normalizedKeyword: string;
  occurrences: number;
}

/** 单个关键词是否可达及命中的证据文档索引。 */
export interface KeywordReachabilityResult {
  keyword: string;
  normalizedKeyword: string;
  reachable: boolean;
  reason?: "empty" | "unreachable";
  evidenceIndexes: number[];
}

/** 一组关键词的源文档可达性结果。 */
export interface KeywordValidationResult {
  ok: boolean;
  reason: "reachable" | "missing" | "empty" | "unreachable";
  keywordResults: KeywordReachabilityResult[];
}

/**
 * 在不改变文本内容的前提下去掉 PDF 空白并统一大小写。
 *
 * 仅移除 Unicode 空白，不删除标点、数字分隔符或全角内容，
 * 因此字符间距、全角间隔与表格多空格可按原文语义匹配。
 *
 * @param text 原文或作者关键词。
 * @returns 可比较的规范化文本。
 */
export function normalizeKeywordText(text: string): string {
  return text.replace(/\s+/gu, "").toLowerCase();
}

/**
 * 扫描解析文本中的全部关键词出现。
 *
 * 空关键词或只含空白的关键词会被忽略；关键词顺序保持不变，
 * 内容相同的作者关键词仍各自返回，不擅自去重内容。
 *
 * @param parsedText 来源文档的解析全文。
 * @param keywords 作者填写的 expected_keywords。
 * @returns 每个有效关键词的命中摘要。
 */
export function findKeywordMatches(
  parsedText: string,
  keywords: readonly string[]
): KeywordMatch[] {
  const normalizedText = normalizeKeywordText(parsedText);
  const matches: KeywordMatch[] = [];

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeKeywordText(keyword);
    if (normalizedKeyword.length === 0) continue;
    matches.push({
      keyword,
      normalizedKeyword,
      occurrences: countOccurrences(normalizedText, normalizedKeyword)
    });
  }

  return matches;
}

/**
 * 校验作者关键词是否命中至少一份来源证据文档。
 *
 * 每个关键词独立扫描全部 evidence，并保留命中文档在数组中的索引，
 * 供后续校验报告定位来源；空关键词不会构成可达性。
 *
 * @param evidence 本次题目引用的全部 PDF 证据文档。
 * @param keywords 作者填写的 expected_keywords。
 * @returns 整体是否全部可达以及逐关键词结果。
 */
export function validateKeywordReachability(
  evidence: readonly PdfEvidenceDocument[],
  keywords: readonly string[]
): KeywordValidationResult {
  if (keywords.length === 0) {
    return {
      ok: false,
      reason: "missing",
      keywordResults: []
    };
  }

  const keywordResults = keywords.map((keyword) => {
    const match = findKeywordMatches("", [keyword])[0];
    if (!match) {
      return {
        keyword,
        normalizedKeyword: "",
        reachable: false,
        reason: "empty" as const,
        evidenceIndexes: []
      };
    }

    const evidenceIndexes = evidence.flatMap((document, index) => {
      const parsedText = document.blocks.map((block) => block.text).join("\n");
      return findKeywordMatches(parsedText, [keyword])[0]?.occurrences
        ? [index]
        : [];
    });

    return {
      keyword,
      normalizedKeyword: match.normalizedKeyword,
      reachable: evidenceIndexes.length > 0,
      ...(evidenceIndexes.length === 0 ? { reason: "unreachable" as const } : {}),
      evidenceIndexes
    };
  });

  const reason = keywordResults.some((result) => result.reason === "empty")
    ? "empty"
    : keywordResults.every((result) => result.reachable)
      ? "reachable"
      : "unreachable";

  return {
    ok: reason === "reachable",
    reason,
    keywordResults
  };
}

/**
 * 统计不重叠的关键词出现次数。
 *
 * @param text 已规范化的全文。
 * @param keyword 已规范化的关键词。
 * @returns 出现次数。
 */
function countOccurrences(text: string, keyword: string): number {
  let count = 0;
  let offset = 0;

  while (offset <= text.length - keyword.length) {
    const index = text.indexOf(keyword, offset);
    if (index === -1) break;
    count += 1;
    offset = index + keyword.length;
  }

  return count;
}
