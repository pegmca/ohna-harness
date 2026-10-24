/**
 * LLM-as-Judge 框架壳（v2.0 薄内核方案 §2.2 / §2.3 边界修正）：
 *
 * 只共享「解析 / 投票 / 降级」机械零件——约 60 行纯函数，零领域知识、零网络依赖、零
 * `@aiagent/agent|ai|rag|trace` 运行时依赖。rubric prompt 文本、`fetch /chat/completions`
 * 调用、`readJudgeProviderConfig` 读取都**不进内核**（属各 app 层，详见 §2.3 第 2 条）。
 *
 * 调用方负责：用 `parseJudgeJson` 解析自己的 rubric 模型输出，用 `roundScore` 钳制，用
 * `majorityVote` / `sampleAndAverage` 做多次采样校准，并用 `NEUTRAL_SCORE` 作为失败降级分。
 */

/** 缺失真实调用条件 / 解析失败时使用的中性分：表示"无法判断、不奖励也不惩罚"。 */
export const NEUTRAL_SCORE = 0.5;

/**
 * 把分数限制在 [0,1] 并保留三位小数。
 *
 * @param score 原始分数。
 * @returns 受限后的分数。
 */
export function roundScore(score: number): number {
  const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : NEUTRAL_SCORE;
  return Math.round(clamped * 1000) / 1000;
}

/**
 * 容错解析模型返回的判定 JSON，支持 ```json 围栏与散落文本中的对象抽取。
 *
 * @param text 模型返回文本。
 * @returns 解析后的对象，失败返回 null。
 */
export function parseJudgeJson(text: string): { score?: unknown; reason?: unknown } | null {
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
 * 多数投票：从一组成败/分数中聚合为单个分数。
 *
 * 非空时取数值均值并 `roundScore` 钳制；空数组时回退 `fallback`（通常即 `NEUTRAL_SCORE`）。
 *
 * @param scores 各次采样分数。
 * @param fallback 无可用分数时的回退分。
 * @returns 聚合分数。
 */
export function majorityVote(scores: readonly number[], fallback: number): number {
  if (scores.length === 0) return fallback;
  const total = scores.reduce((sum, value) => sum + value, 0);
  return roundScore(total / scores.length);
}

/**
 * 真实模型模式下对同一样本多次采样取平均（多数投票校准），并把失败降级为中性分。
 *
 * 模型调用边界 `callModel` 由调用方注入（app 层负责真实 fetch / 替身）；内核只负责
 * 循环采样、解析、钳制与失败降级，**任何异常都在此吞掉并降级，绝不向上抛**。
 *
 * @param callModel 模型调用边界：`(system, user) => Promise<string>`。
 * @param systemPrompt 系统提示（由各 app 的 rubric 提供）。
 * @param userPrompt 用户提示（由各 app 的 rubric 提供）。
 * @param samples 采样次数（调用方应保证 ≥ 1）。
 * @returns 平均分数与首条 reason（失败则中性分 + reason）。
 */
export async function sampleAndAverage(
  callModel: (system: string, user: string) => Promise<string>,
  systemPrompt: string,
  userPrompt: string,
  samples: number,
): Promise<{ score: number; reason: string }> {
  const count = Math.max(1, Math.floor(samples));
  let total = 0;
  let actual = 0;
  let reason = "";
  for (let i = 0; i < count; i += 1) {
    try {
      const content = await callModel(systemPrompt, userPrompt);
      const parsed = parseJudgeJson(content);
      const score = typeof parsed?.score === "number" ? roundScore(parsed.score) : NEUTRAL_SCORE;
      total += score;
      actual += 1;
      if (!reason && typeof parsed?.reason === "string") reason = parsed.reason;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reason = `judge 调用失败，降级中性分：${message}`;
    }
  }
  const score = actual > 0 ? roundScore(total / actual) : NEUTRAL_SCORE;
  return { score, reason: reason || "多次采样均无可用理由，使用平均/中性分。" };
}
