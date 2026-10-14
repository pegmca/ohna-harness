/**
 * eval 包测试替身（test double）集中地。
 *
 * v1.1 改造后，judge 工厂（createLlmJudge / createLoopLlmJudge）在 provider 禁用时返回 `null`，
 * 不再静默回退到"中性分 / 确定性 mock"——那会伪装成 judge 已运行却给出无意义基线，掩盖配置缺失。
 * 原先的确定性判定逻辑（词元重叠率）与中性基线被降级为 **仅供测试显式注入** 的 test double，
 * 移出生产模块，避免误用为生产默认。
 */

import type { ContextRecallJudgement, FaithfulnessJudgement, LlmJudge } from "./judge.js";
import type { JudgeScore, LoopLlmJudge } from "./judge-loop.js";

/** 缺失真实调用条件时使用的中性分，表示"无法判断、不奖励也不惩罚"（测试/降级基线定义）。 */
export const NEUTRAL_SCORE = 0.5;

/**
 * 创建中性 judge（测试替身）：任何判定都返回中性分，用于"禁用 judge"场景的基线注入，
 * 不再由生产工厂在 env 缺失时静默生成。
 *
 * @returns 永远返回中性分的 LlmJudge。
 */
export function createNeutralLlmJudge(): LlmJudge {
  return {
    judgeFaithfulness: (_question, _answer, _contexts): Promise<FaithfulnessJudgement> =>
      Promise.resolve({ score: NEUTRAL_SCORE, reason: "judge 已禁用，返回中性分（测试/降级基线）。" }),
    judgeContextRecall: (_expectedContexts, _retrievedContexts): Promise<ContextRecallJudgement> =>
      Promise.resolve({ score: NEUTRAL_SCORE })
  };
}

/** 中英文常用停用词，过滤后对"有意义词元"做重叠比较，逼近语义等价。 */
const STOPWORDS = new Set([
  "公司", "的", "了", "是", "和", "与", "或", "在", "为", "有", "我", "你", "他", "她", "它",
  "我们", "你们", "他们", "这", "那", "这些", "那些", "一个", "一些", "什么", "怎么", "如何",
  "多少", "是否", "可以", "已经", "现在", "当时", "目前", "the", "a", "an", "is", "are", "was",
  "were", "be", "been", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "of", "to", "in", "on", "at", "for", "with", "by", "from",
  "as", "and", "or", "but", "not", "no", "this", "that", "these", "those"
]);

/**
 * 把分数限制在 [0,1] 并保留三位小数。
 *
 * @param score 原始分数。
 * @returns 受限后的分数。
 */
function roundScore(score: number): number {
  const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : NEUTRAL_SCORE;
  return Math.round(clamped * 1000) / 1000;
}

/**
 * 提取文本中有意义的词元（过滤停用词与过短/纯短数字 token）。
 * 注：中文无空格时按非中英文数字边界切分，整句作为一个词元；这是 deterministic 近似，
 * 真实语义等价由可选的真实模型模式承担。
 *
 * @param text 输入文本。
 * @returns 词元集合。
 */
function extractMeaningfulTerms(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
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
 * 确定性 answer correctness：答案词元被期望文本词元覆盖的比例。
 * 完全可复现，测试依赖它的确定性。
 *
 * @param answer 答案文本。
 * @param expectedText 期望参考文本。
 * @returns 分数与理由。
 */
function deterministicAnswerCorrectness(answer: string, expectedText: string): JudgeScore {
  const answerTerms = extractMeaningfulTerms(answer);
  const expectedTerms = extractMeaningfulTerms(expectedText);
  if (expectedTerms.size === 0) {
    return { score: 1, reason: "期望文本无可提取词元，视为一致（确定性 mock）。" };
  }
  const hits = [...expectedTerms].filter((term) => answerTerms.has(term)).length;
  const score = roundScore(hits / expectedTerms.size);
  return {
    score,
    reason: `期望词元 ${expectedTerms.size} 个，答案命中 ${hits} 个（确定性 mock 重叠率 ${(score * 100).toFixed(0)}%）。`
  };
}

/**
 * 确定性 faithfulness：答案词元被检索上下文词元覆盖的比例；无上下文返回中性分。
 * 完全可复现，测试依赖它的确定性。
 *
 * @param answer 答案文本。
 * @param contexts 检索到的上下文文本列表。
 * @returns 分数与理由。
 */
function deterministicFaithfulness(answer: string, contexts: readonly string[]): JudgeScore {
  const answerTerms = extractMeaningfulTerms(answer);
  if (answerTerms.size === 0) {
    return { score: 1, reason: "答案无可提取词元，默认认为忠实（确定性 mock）。" };
  }
  if (contexts.length === 0) {
    return { score: NEUTRAL_SCORE, reason: "无检索上下文，确定性 mock 返回中性分。" };
  }
  const contextTerms = extractMeaningfulTerms(contexts.join(" "));
  const hits = [...answerTerms].filter((term) => contextTerms.has(term)).length;
  const score = roundScore(hits / answerTerms.size);
  return {
    score,
    reason: `答案词元 ${answerTerms.size} 个，被上下文支撑 ${hits} 个（确定性 mock 覆盖率 ${(score * 100).toFixed(0)}%）。`
  };
}

/**
 * 创建确定性 mock loop judge（测试替身，复刻旧 env-missing 时的可复现打分）。
 *
 * 用"有意义词元重叠率"打分，分数完全可复现；测试据此断言确定性行为。
 * samples 参数保留以兼容旧调用签名，但确定性模式不采样，直接返回单轮结果。
 *
 * @param _samples 兼容旧签名的采样次数（确定性模式忽略，仅真实模型模式使用）。
 * @returns 确定性 LoopLlmJudge。
 */
export function createDeterministicMockLoopLlmJudge(_samples = 3): LoopLlmJudge {
  return {
    judgeAnswerCorrectness: (_question, answer, expectedText) =>
      Promise.resolve(deterministicAnswerCorrectness(answer, expectedText)),
    judgeFaithfulness: (answer, contexts) => Promise.resolve(deterministicFaithfulness(answer, contexts))
  };
}
