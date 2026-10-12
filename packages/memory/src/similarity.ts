/**
 * 本地相似度（学习级语义检索替代物）。
 *
 * 为什么不用向量库：生产级语义记忆通常依赖 PG + pgvector / 外部向量 DB 做 embedding 检索。
 * 本学习包刻意不引入任何向量依赖，改用「词频 bag-of-words + 余弦相似度」在内存中对
 * episode 文本做确定性相似度打分（pi 项目同样没有向量 DB——"需要 RAG 自行叠加"）。
 * 这是可解释、零依赖的占位实现，未来可平滑替换为真实 embedding + 向量检索，接口不变。
 */

/**
 * 分词：转小写，按非字母数字切分，过滤空串。
 * 学习级 tokenizer，足够支撑 TF 余弦；不处理中文分词（中文场景下按字/词需另行处理）。
 *
 * @param text 输入文本。
 * @returns 小写 token 列表。
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * 计算词频表（term frequency）。
 *
 * @param tokens 已分词列表。
 * @returns token → 出现次数 的映射。
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * 余弦相似度：在两个词频向量上计算，返回 0~1。
 * 只在交集 term 上累加点积，省去零值计算，对长文本更友好。
 *
 * @param a 文本 a。
 * @param b 文本 b。
 * @returns 余弦相似度；任一为空文本时返回 0。
 */
export function cosineSimilarity(a: string, b: string): number {
  const ta = termFrequency(tokenize(a));
  const tb = termFrequency(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let normA = 0;
  for (const count of ta.values()) normA += count * count;
  let normB = 0;
  for (const count of tb.values()) normB += count * count;

  // 在较小向量上迭代，只在交集 term 上累加点积。
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let dot = 0;
  for (const [term, count] of small) {
    const other = large.get(term);
    if (other) dot += count * other;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Jaccard 相似度（token 集合交集 / 并集），作为余弦的补充可选指标。
 *
 * @param a 文本 a。
 * @param b 文本 b。
 * @returns 0~1 的 Jaccard 系数。
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 0;

  let intersection = 0;
  for (const token of sa) {
    if (sb.has(token)) intersection += 1;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
