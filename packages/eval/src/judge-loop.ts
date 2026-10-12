/**
 * Loop eval 的 LLM-as-Judge 层（docs/v1.1/04-eval-observability.md P0）。
 *
 * 背景：`runLoopEval` 跑真 `agentLoop` + mock streamFn，证据来自 run_events 投影，再由
 * `scoreCaseWithEvidence` 做确定性打分与门禁。确定性 rubric 只能做关键词级近似，无法理解语义等价
 * 与同义改写。本文件提供"答案正确性 / 忠实性"两个语义 rubric 的 judge，作为校准信号追加到逐条结果
 * （不计入门禁）。
 *
 * 设计原则（对齐 judge.ts 的 RAG judge 范式）：
 * 1. 默认确定性 mock 模式（无网络）：用"有意义词元重叠率"打分，分数完全可复现，测试依赖它；
 * 2. 真实模型模式可选：仅当显式给出 baseUrl+apiKey（或从 bridge env 读到）时，用 fetch 调
 *    `/chat/completions`（temperature=0、response_format=json_object），解析 score，失败/解析不出
 *    → 降级中性分 0.5 并附 reason；对两个 rubric 各采样 `samples`（默认 3）次取平均（多数投票校准）；
 * 3. 任何失败一律降级为结构化中性结果，绝不 throw 到 eval 主流程。
 */
import { BRIDGE_ENV, readBridgeConfig } from "@aiagent/rag";

/** 单条 judge 判定结果（分数 + 理由）。 */
export interface JudgeScore {
  /** 0~1 分数。 */
  score: number;
  /** 判定理由，供报告可读与调试。 */
  reason: string;
}

/** Loop eval 的 LLM-as-Judge 接口（校准信号，不阻塞门禁）。 */
export interface LoopLlmJudge {
  /**
   * 判定答案正确性：答案是否覆盖了期望回答的要点。
   *
   * @param question 用户问题。
   * @param answer 生成的答案文本。
   * @param expectedText 由期望事实/引用拼接而成的参考文本。
   * @returns 分数与理由；失败时返回中性分 + reason。
   */
  judgeAnswerCorrectness(question: string, answer: string, expectedText: string): Promise<JudgeScore>;

  /**
   * 判定忠实性（faithfulness）：答案中的论断是否都能被检索到的上下文支撑（无幻觉）。
   *
   * @param answer 生成的答案文本。
   * @param contexts 检索到的上下文文本列表。
   * @returns 分数与理由；失败时返回中性分 + reason。
   */
  judgeFaithfulness(answer: string, contexts: readonly string[]): Promise<JudgeScore>;
}

/** judge 工厂配置（未传则从 bridge env 读取）。 */
export interface LoopLlmJudgeOptions {
  /** OpenAI 兼容端点（不含末尾 /v1 也行，调用时统一拼 /chat/completions）。 */
  baseUrl?: string;
  /** API key。 */
  apiKey?: string;
  /** 模型名。 */
  model?: string;
  /** 真实模型模式下每个 rubric 的采样次数（多数投票校准），默认 3。 */
  samples?: number;
}

/** 缺失真实调用条件时使用的中性分，表示"无法判断、不奖励也不惩罚"。 */
const NEUTRAL_SCORE = 0.5;

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
 * 容错解析模型返回的判定 JSON，支持 ```json 围栏与散落文本中的对象抽取。
 *
 * @param text 模型返回文本。
 * @returns 解析后的对象，失败返回 null。
 */
function parseJudgeJson(text: string): { score?: unknown; reason?: unknown } | null {
  if (!text || text.trim().length === 0) return null;

  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();

  try {
    return JSON.parse(cleaned) as { score?: unknown; reason?: unknown };
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as { score?: unknown; reason?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
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
 * 创建 loop eval 的 LLM-as-Judge。
 *
 * 未显式传入 baseUrl/apiKey 时，从 bridge 环境变量读取（复用 @aiagent/rag 的 readBridgeConfig，
 * 即 AIAGENT_LLM_*_BRIDGE_AI）。仅当 baseUrl 与 apiKey 均非空才启用真实模型模式；否则走确定性
 * mock 模式（无网络、分数可复现）。任何真实调用失败都降级为中性分，绝不抛异常。
 *
 * @param options 可选端点与采样配置。
 * @returns LoopLlmJudge 实例。
 */
export function createLoopLlmJudge(options: LoopLlmJudgeOptions = {}): LoopLlmJudge {
  const bridge = readBridgeConfig();
  const baseUrl = (options.baseUrl ?? bridge.baseUrl).trim();
  const apiKey = (options.apiKey ?? bridge.apiKey).trim();
  const model = (options.model ?? bridge.model).trim();
  const samples = Math.max(1, Math.floor(options.samples ?? 3));
  const enabled = baseUrl.length > 0 && apiKey.length > 0;

  // 仅在具备真实调用条件时绑定 fetch 调用；否则保持 null，判定降级为确定性 mock。
  const callModel: ((systemPrompt: string, userPrompt: string) => Promise<string>) | null = enabled
    ? async (systemPrompt: string, userPrompt: string): Promise<string> => {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0,
            response_format: { type: "json_object" }
          })
        });

        if (!response.ok) {
          throw new Error(`loop judge request failed with status ${response.status}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data?.choices?.[0]?.message?.content ?? "";
      }
    : null;

  return createLoopJudgeWithCallModel(callModel, samples);
}

/**
 * 组装 judge 实现：根据 callModel 是否为 null 选择真实模型或确定性 mock，并对真实模式做多次采样平均。
 *
 * @param callModel 模型调用边界；为 null 时走确定性 mock。
 * @param samples 真实模式下每个 rubric 的采样次数。
 * @returns LoopLlmJudge 实现。
 */
function createLoopJudgeWithCallModel(
  callModel: ((systemPrompt: string, userPrompt: string) => Promise<string>) | null,
  samples: number
): LoopLlmJudge {
  return {
    judgeAnswerCorrectness: async (question, answer, expectedText) => {
      if (!callModel) {
        return deterministicAnswerCorrectness(answer, expectedText);
      }
      const userPrompt =
        `用户问题：\n${question}\n\n` +
        `模型答案：\n${answer}\n\n` +
        `期望应被覆盖的参考要点：\n${expectedText}\n\n` +
        `请判断模型答案是否正确覆盖了参考要点（含同义表述）。仅输出 JSON：` +
        `{ "score": 0~1 的数字, "reason": string }。`;
      return sampleAndAverage(callModel, ANSWER_CORRECTNESS_SYSTEM_PROMPT, userPrompt, samples);
    },

    judgeFaithfulness: async (answer, contexts) => {
      if (!callModel) {
        return deterministicFaithfulness(answer, contexts);
      }
      const contextText = contexts.length > 0 ? contexts.join("\n\n---\n\n") : "（无检索上下文）";
      const userPrompt =
        `用户答案：\n${answer}\n\n` +
        `检索到的上下文：\n${contextText}\n\n` +
        `请判断答案中的每个论断是否都能被上述上下文直接支撑（含同义表述）；推断或上下文未提及的论断视为不忠实。` +
        `仅输出 JSON：{ "score": 0~1 的数字, "reason": string }。`;
      return sampleAndAverage(callModel, FAITHFULNESS_SYSTEM_PROMPT, userPrompt, samples);
    }
  };
}

/** answer correctness 判定的 system prompt。 */
const ANSWER_CORRECTNESS_SYSTEM_PROMPT =
  "你是金融研究 agent 的评估裁判。请判断【模型答案】是否正确覆盖了【期望参考要点】的关键信息（允许同义改写）。" +
  "只有要点被明确覆盖才算正确；缺漏或事实冲突视为不正确。只输出 JSON，格式：{ \"score\": 0~1 的数字, \"reason\": string }。";

/** faithfulness 判定的 system prompt。 */
const FAITHFULNESS_SYSTEM_PROMPT =
  "你是金融研究 agent 的评估裁判。请判断【答案】中的每个论断是否都能被【检索到的上下文】直接支撑。" +
  "只有上下文明确包含该论断（含同义表述）才算支撑；推断、臆测或上下文未提及的论断视为不忠实。" +
  "只输出 JSON，格式：{ \"score\": 0~1 的数字, \"reason\": string }。";

/**
 * 真实模型模式下对同一样本多次采样取平均（多数投票校准），并把失败降级为中性分。
 *
 * @param callModel 模型调用边界。
 * @param systemPrompt 系统提示。
 * @param userPrompt 用户提示。
 * @param samples 采样次数。
 * @returns 平均分数与首条 reason（失败则中性分 + reason）。
 */
async function sampleAndAverage(
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>,
  systemPrompt: string,
  userPrompt: string,
  samples: number
): Promise<JudgeScore> {
  let total = 0;
  let count = 0;
  let reason = "";
  for (let i = 0; i < samples; i += 1) {
    try {
      const content = await callModel(systemPrompt, userPrompt);
      const parsed = parseJudgeJson(content);
      const score = typeof parsed?.score === "number" ? roundScore(parsed.score) : NEUTRAL_SCORE;
      total += score;
      count += 1;
      if (!reason && typeof parsed?.reason === "string") reason = parsed.reason;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reason = `loop judge 调用失败，降级中性分：${message}`;
    }
  }
  const score = count > 0 ? roundScore(total / count) : NEUTRAL_SCORE;
  return { score, reason: reason || "多次采样均无可用理由，使用平均/中性分。" };
}
