/**
 * finance-api RAG 评测 judge rubric（v2.0 评测体系 Step 3，领域自治方案 §2.3 边界修正 / §3.3）。
 *
 * 内核只提供「解析 / 投票 / 降级」机械零件（@aiagent/eval-core 的 parseJudgeJson / roundScore
 * / NEUTRAL_SCORE 等）；rubric prompt 文本与真实 fetch 调用留 app 层。本文件：
 * - 复用 @aiagent/rag 的 readJudgeProviderConfig 读取 judge provider；**缺配置返回 null**（不静默回退）。
 * - 导出 faithfulness / contextRecall / contextPrecision 三个 rubric 的 systemPrompt 常量与解析器
 *   （rubric 文本与 fetch 留 app，内核只提供 parseJudgeJson / roundScore 等框架）。
 * - createFinanceRagJudge(options?) 返回 run 层需要的 `FinanceRagJudge` 适配器：有配置时真实
 *   调 `/chat/completions` 打分，无配置时整体返回 null（run 层据此跳过 judge，不影响确定性门禁）。
 */

import type { RagAnswer } from "@aiagent/rag";
import { readJudgeProviderConfig } from "@aiagent/rag";
import { NEUTRAL_SCORE, parseJudgeJson, roundScore } from "@aiagent/eval-core";
import type { FinanceRagJudge } from "./run.js";
import type { FinanceEvalCaseLike } from "./metrics.js";

/** judge provider 配置类型（`@aiagent/rag` 未导出该命名类型，这里用返回值推导）。 */
type JudgeProviderConfig = ReturnType<typeof readJudgeProviderConfig>;

/** judge 输出里的分数键名（与 rubric 约定一致）。 */
const SCORE_KEYS = ["score", "faithfulness", "contextRecall", "contextPrecision"] as const;

/**
 * 从 judge 模型返回的任意 JSON 中抽取分数（稳健：尝试多个常见键名）。
 *
 * @param text 模型返回文本。
 * @returns 受限到 [0,1] 的分数；解析失败或字段缺失时返回中性分。
 */
function extractScore(text: string): number {
  const parsed = parseJudgeJson(text);
  if (!parsed) return NEUTRAL_SCORE;
  for (const key of SCORE_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number") return roundScore(value);
  }
  return NEUTRAL_SCORE;
}

/** faithfulness rubric：判断答案是否被检索证据支撑（RAGAS faithfulness）。 */
export const FAITHFULNESS_SYSTEM_PROMPT = [
  "你是金融 RAG 评测的 faithfulness 裁判。",
  "给定「用户问题 / 检索到的证据片段 / 生成的回答」，判断回答中的每一条主张是否都能",
  "被检索证据支撑。完全基于证据、无编造 → 1.0；部分主张无证据 → 0.5；明显编造 → 0.0。",
  "只输出 JSON：{\"score\": <0..1>, \"reason\": \"<中文简评>\"}。"
].join("\n");

/** contextRecall rubric：期望证据是否都被检索召回（输入 goldEvidence）。 */
export const CONTEXT_RECALL_SYSTEM_PROMPT = [
  "你是金融 RAG 评测的 contextRecall 裁判。",
  "给定「用户问题 / 期望证据（goldEvidence）/ 实际检索到的证据片段」，判断期望证据中有多少",
  "被实际检索结果覆盖。全部覆盖 → 1.0；部分覆盖 → 0.5；几乎未覆盖 → 0.0。",
  "只输出 JSON：{\"score\": <0..1>, \"reason\": \"<中文简评>\"}。"
].join("\n");

/** contextPrecision rubric：召回内容是否纯净（噪声占比）。 */
export const CONTEXT_PRECISION_SYSTEM_PROMPT = [
  "你是金融 RAG 评测的 contextPrecision 裁判。",
  "给定「用户问题 / 实际检索到的证据片段」，判断召回内容中与问题相关的比例（排除无关噪声）。",
  "高度纯净 → 1.0；约一半相关 → 0.5；大量噪声 → 0.0。",
  "只输出 JSON：{\"score\": <0..1>, \"reason\": \"<中文简评>\"}。"
].join("\n");

/** 每个 rubric 名对应的系统提示（供 createFinanceRagJudge 取用）。 */
const RUBRIC_PROMPTS: Record<"faithfulness" | "contextRecall" | "contextPrecision", string> = {
  faithfulness: FAITHFULNESS_SYSTEM_PROMPT,
  contextRecall: CONTEXT_RECALL_SYSTEM_PROMPT,
  contextPrecision: CONTEXT_PRECISION_SYSTEM_PROMPT
};

/**
 * 把一条 case + 真实 answer 渲染为某 rubric 的用户提示。
 *
 * @param rubric rubric 名。
 * @param case_ 金融评测 case（含 query / goldEvidence）。
 * @param answer 真实 runtime 产出的 RagAnswer。
 * @returns 用户提示文本。
 */
function renderUserPrompt(
  rubric: "faithfulness" | "contextRecall" | "contextPrecision",
  case_: FinanceEvalCaseLike & { query: string; goldEvidence?: string[] },
  answer: RagAnswer
): string {
  const retrieved = answer.retrievalResults
    .map((result, index) => `[${index + 1}] (source=${result.citation.source}, doc=${result.citation.documentId}) ${result.text}`)
    .join("\n");

  if (rubric === "contextRecall") {
    const gold = (case_.goldEvidence ?? []).join("\n- ");
    return `用户问题：${case_.query}\n\n期望证据（goldEvidence）：\n- ${gold}\n\n实际检索到的证据：\n${retrieved}`;
  }

  if (rubric === "contextPrecision") {
    return `用户问题：${case_.query}\n\n实际检索到的证据：\n${retrieved}`;
  }

  // faithfulness：判断是否基于证据。
  return `用户问题：${case_.query}\n\n检索到的证据：\n${retrieved}\n\n生成的回答：\n${answer.answer}`;
}

/**
 * 创建金融 RAG judge 适配器。
 *
 * 复用 @aiagent/rag 的 readJudgeProviderConfig 读取 judge provider；**缺配置直接返回 null**，
 * 不静默回退（避免无配置时假装能评测）。有配置时真实调用 `/chat/completions` 打分，
 * 失败降级为中性分（NEUTRAL_SCORE，不奖励也不惩罚）。
 *
 * @param options 可选：callModel 注入（测试可用替身）；不传则使用真实 fetch 调用。
 * @returns FinanceRagJudge 适配器，或 null（无 judge 配置）。
 */
export function createFinanceRagJudge(
  options?: { callModel?: (system: string, user: string) => Promise<string> }
): FinanceRagJudge | null {
  // 测试 / 注入替身场景：显式传入 callModel 时直接使用，不依赖 provider 配置（否则无法离线验证）。
  if (options?.callModel) {
    return buildJudge(options.callModel);
  }

  const config: JudgeProviderConfig = readJudgeProviderConfig();
  if (!config.enabled) {
    // 缺配置：显式返回 null，由 run 层决定跳过 judge（不静默回退）。
    return null;
  }

  const callModel = (async (system: string, user: string): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        return JSON.stringify({ score: NEUTRAL_SCORE, reason: `judge HTTP ${response.status}` });
      }
      const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return payload.choices?.[0]?.message?.content ?? JSON.stringify({ score: NEUTRAL_SCORE });
    } catch {
      // 网络/超时/解析异常：降级中性分，绝不抛出（judge 只产校准信号）。
      return JSON.stringify({ score: NEUTRAL_SCORE, reason: "judge 调用失败，降级中性分" });
    } finally {
      clearTimeout(timeout);
    }
  });

  return buildJudge(callModel);
}

/**
 * 用给定的模型调用边界构建 judge 适配器（注入与现实 fetch 两条路径共用）。
 *
 * @param callModel 模型调用边界（注入替身或真实 fetch）。
 * @returns FinanceRagJudge 适配器。
 */
function buildJudge(callModel: (system: string, user: string) => Promise<string>): FinanceRagJudge {
  return {
    async score(rubric, case_, answer) {
      const system = RUBRIC_PROMPTS[rubric];
      const user = renderUserPrompt(rubric, case_, answer);
      const text = await callModel(system, user);
      return extractScore(text);
    }
  };
}
