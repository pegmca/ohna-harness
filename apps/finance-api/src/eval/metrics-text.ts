/**
 * 金融 RAG 评测指标的纯文本工具（无领域语义，供 metrics.ts 内部复用）。
 *
 * 集中放置停用词集合与文本规范化 / 词元提取 / 分数取整逻辑，避免 metrics.ts 主模块
 * 混入与指标定义无关的通用 helper，保持单文件职责单一（约定 ≤500 行）。
 */

/** 停用词集合：过滤中英文常见虚词，避免检索/答案词元匹配噪声（金融 RAG 确定性指标内部复用）。 */
const STOPWORDS = new Set([
  "公司", "的", "了", "是", "和", "与", "或", "在", "为", "有", "我", "你", "他", "她", "它",
  "我们", "你们", "他们", "这", "那", "这些", "那些", "一个", "一些", "什么", "怎么", "如何",
  "多少", "是否", "可以", "已经", "现在", "当时", "目前",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "must",
  "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "and", "or",
  "but", "not", "no", "this", "that", "these", "those"
]);

/**
 * 规范化文本：小写 + 压缩空白，用于大小写不敏感匹配。
 *
 * @param text 原始文本。
 * @returns 规范化后的文本。
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 提取文本中有意义的词元（中英文混合），用于确定性指标。
 *
 * 过滤常见停用词、过短 token 与纯短数字，避免噪声匹配。
 *
 * @param text 输入文本。
 * @returns 词元集合。
 */
export function extractMeaningfulTerms(text: string): Set<string> {
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
 * 将分数保留三位小数，避免浮点误差导致报告可读性差。
 *
 * @param score 原始分数。
 * @returns 保留三位小数的分数。
 */
export function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
