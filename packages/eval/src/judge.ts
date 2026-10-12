/**
 * LLM-as-judge 指标（对齐 RAGAS faithfulness / context recall）。
 *
 * 背景：packages/eval 当前四个指标（retrievalHitRate / answerCorrectness / faithfulness /
 * citationCoverage）都是 deterministic rubric，只能做关键词级近似，无法理解语义等价与同义改写。
 * 本文件用 LLM judge 做语义级校准，对齐 RAGAS 的两个核心语义指标：
 *
 * - faithfulness（忠实性）：答案中的每一个论断是否都能在检索到的 contexts 中找到支撑（无幻觉）。
 * - context recall（上下文召回）：期望应被召回的证据（expectedContexts）是否都出现在实际检索结果中。
 *
 * 设计原则：
 * 1. judge 是"校准信号"而非"阻塞信号"——任何失败（key 缺失、网络超时、返回非 JSON）都降级为中性分
 *    （默认 0.5）并附 reason，绝不向上抛异常，避免把 eval 套件变成"有网才能跑"。
 * 2. 优先使用 @aiagent/ai 的 streamSimple；本实现统一走 OpenAI 兼容 `/chat/completions` fetch，
 *    与 P1/P2 的 bridge 调用模式一致，且不引入额外依赖。import type 隔离运行时依赖。
 * 3. 未显式传端点时从 bridge 环境变量读取（统一引用 @aiagent/rag 的 BRIDGE_ENV / readBridgeConfig，
 *    避免 env 名称在多个包各自硬编码产生漂移），但调用方若未配置 key，judge 返回中性分，不破坏 eval 默认行为。
 */

// 复用 @aiagent/rag 的 bridge 配置契约：env 名称的唯一真源，避免重复定义导致漂移。
import { BRIDGE_ENV, readBridgeConfig } from "@aiagent/rag";

/** 单条 faithfulness 判定结果。 */
export interface FaithfulnessJudgement {
  /** 0~1 忠实性分数。 */
  score: number;
  /** 判定理由，供报告可读与调试。 */
  reason: string;
}

/** 单条 context recall 判定结果。 */
export interface ContextRecallJudgement {
  /** 0~1 上下文召回分数。 */
  score: number;
}

/** LLM judge 对外接口。 */
export interface LlmJudge {
  /**
   * 判定 faithfulness：答案是否被 contexts 支撑。
   *
   * @param question 用户问题。
   * @param answer 生成的答案文本。
   * @param contexts 检索到的上下文文本列表。
   * @returns 分数与理由；失败时返回中性分 + reason。
   */
  judgeFaithfulness(question: string, answer: string, contexts: readonly string[]): Promise<FaithfulnessJudgement>;

  /**
   * 判定 context recall：期望证据是否被实际检索覆盖。
   *
   * @param expectedContexts 期望应被召回的证据文本列表。
   * @param retrievedContexts 实际检索到的上下文文本列表。
   * @returns 分数；失败时返回中性分。
   */
  judgeContextRecall(expectedContexts: readonly string[], retrievedContexts: readonly string[]): Promise<ContextRecallJudgement>;
}

/** judge 工厂配置（未传则从 bridge env 读取）。 */
export interface LlmJudgeOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** 缺失真实调用条件时使用的中性分，表示"无法判断、不奖励也不惩罚"。 */
const NEUTRAL_SCORE = 0.5;

/** faithfulness 判定的 system prompt。 */
const FAITHFULNESS_SYSTEM_PROMPT =
  "你是 RAG 评估裁判。请判断【答案】中的每个论断是否都能被【检索到的上下文】直接支撑。" +
  "只有上下文明确包含该论断（含同义表述）才算支撑；推断、臆测或上下文未提及的论断视为不忠实。" +
  "只输出 JSON，格式：{ \"score\": 0~1 之间的数字, \"reason\": string }。";

/** context recall 判定的 system prompt。 */
const CONTEXT_RECALL_SYSTEM_PROMPT =
  "你是 RAG 评估裁判。请判断【期望应被召回的证据】是否都出现在【实际检索到的上下文】中。" +
  "若期望证据的关键信息在实际上下文里能找到（含同义表述）则算召回；缺失则扣分。" +
  "只输出 JSON，格式：{ \"score\": 0~1 之间的数字, \"reason\": string }。";

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
 * 创建 LLM judge。
 *
 * 未显式传入 baseUrl/apiKey/model 时，从 bridge 环境变量读取（复用 @aiagent/rag 的 readBridgeConfig，
 * 即 AIAGENT_LLM_*_BRIDGE_AI）。若 baseUrl 或 apiKey 缺失（无真实调用条件），judge 不抛异常，
 * 而是对每个判定返回中性分 + 说明，保证 eval 套件在无 key 环境下仍可运行。
 *
 * @param options 可选端点配置。
 * @returns LlmJudge 实例。
 */
export function createLlmJudge(options: LlmJudgeOptions = {}): LlmJudge {
  // 优先使用显式传入配置；否则从 @aiagent/rag 的 bridge 契约读取唯一真源的 env 名称。
  const bridge = readBridgeConfig();
  const baseUrl = (options.baseUrl ?? bridge.baseUrl).trim();
  const apiKey = (options.apiKey ?? bridge.apiKey).trim();
  const model = (options.model ?? bridge.model).trim();
  const enabled = baseUrl.length > 0 && apiKey.length > 0;

  // 仅在具备真实调用条件时绑定 fetch 调用；否则保持 null，判定降级为中性分。
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
          throw new Error(`judge request failed with status ${response.status}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data?.choices?.[0]?.message?.content ?? "";
      }
    : null;

  return {
    judgeFaithfulness: createFaithfulnessJudge(callModel),
    judgeContextRecall: createContextRecallJudge(callModel)
  };
}

/**
 * 创建 faithfulness 判定函数。
 *
 * @param callModel 模型调用边界；为 null 时降级为中性分。
 * @returns faithfulness 判定函数。
 */
function createFaithfulnessJudge(
  callModel: ((systemPrompt: string, userPrompt: string) => Promise<string>) | null
): (question: string, answer: string, contexts: readonly string[]) => Promise<FaithfulnessJudgement> {
  return async (question: string, answer: string, contexts: readonly string[]): Promise<FaithfulnessJudgement> => {
    if (!callModel) {
      return {
        score: NEUTRAL_SCORE,
        reason: `bridge env 未配置（缺少 ${BRIDGE_ENV.baseUrl} / ${BRIDGE_ENV.apiKey}），judge 降级为中性分。`
      };
    }

    const contextText = contexts.length > 0 ? contexts.join("\n\n---\n\n") : "（无检索上下文）";
    const userPrompt =
      `用户问题：\n${question}\n\n` +
      `答案：\n${answer}\n\n` +
      `检索到的上下文：\n${contextText}\n\n` +
      `请判断答案中的每个论断是否都能被上述上下文支撑。仅输出 JSON。`;

    try {
      const content = await callModel(FAITHFULNESS_SYSTEM_PROMPT, userPrompt);
      const parsed = parseJudgeJson(content);
      const score = typeof parsed?.score === "number" ? roundScore(parsed.score) : NEUTRAL_SCORE;
      const reason = typeof parsed?.reason === "string" ? parsed.reason : "模型未返回 reason，使用中性分。";
      return { score, reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { score: NEUTRAL_SCORE, reason: `judge 调用失败，降级中性分：${message}` };
    }
  };
}

/**
 * 创建 context recall 判定函数。
 *
 * @param callModel 模型调用边界；为 null 时降级为中性分。
 * @returns context recall 判定函数。
 */
function createContextRecallJudge(
  callModel: ((systemPrompt: string, userPrompt: string) => Promise<string>) | null
): (expectedContexts: readonly string[], retrievedContexts: readonly string[]) => Promise<ContextRecallJudgement> {
  return async (
    expectedContexts: readonly string[],
    retrievedContexts: readonly string[]
  ): Promise<ContextRecallJudgement> => {
    if (!callModel) {
      return { score: NEUTRAL_SCORE };
    }

    const expectedText = expectedContexts.length > 0 ? expectedContexts.join("\n\n---\n\n") : "（无期望证据）";
    const retrievedText = retrievedContexts.length > 0 ? retrievedContexts.join("\n\n---\n\n") : "（无检索结果）";
    const userPrompt =
      `期望应被召回的证据：\n${expectedText}\n\n` +
      `实际检索到的上下文：\n${retrievedText}\n\n` +
      `请判断期望证据是否都出现在实际检索上下文中。仅输出 JSON。`;

    try {
      const content = await callModel(CONTEXT_RECALL_SYSTEM_PROMPT, userPrompt);
      const parsed = parseJudgeJson(content);
      const score = typeof parsed?.score === "number" ? roundScore(parsed.score) : NEUTRAL_SCORE;
      return { score };
    } catch {
      return { score: NEUTRAL_SCORE };
    }
  };
}
