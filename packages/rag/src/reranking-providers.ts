import {
  type Reranker,
  type RerankResult,
  type RetrievedChunk
} from "./types.js";
import { createHeuristicReranker } from "./retrieval.js";
import { readBridgeRerankConfig } from "./bridge-config.js";

/**
 * OpenAI 兼容 rerank 端点的配置。
 *
 * 统一走私有 bridge（base URL 形如 `http://host/v1`），所有真实 provider 调用都复用它，
 * 避免在 rerank 实现里硬编码端点或 key；model 即 rerank/cross-encoder 模型名。
 */
export interface OpenAiCompatibleRerankerOptions {
  /** OpenAI 兼容端点（含 /v1 前缀，base URL 不含具体路径）。 */
  baseUrl: string;
  /** 鉴权 Bearer token，来自 bridge 环境变量。 */
  apiKey: string;
  /** rerank 模型名（如 bge-reranker-v2-m3）。 */
  model: string;
}

/**
 * 将分数限制在 0 到 1，避免 rerank / judge 返回的不同尺度（部分实现不是 0..1）污染 finalScore 加权。
 *
 * @param score 原始分数。
 * @returns 归一范围内的分数。
 */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 为 rerank 结果生成 queryTerms（信息性字段）。
 *
 * 与检索侧 tokenizer 保持同构的轻量实现：英文/数字按词、中文按单字，去重后返回，
 * 便于 trace 与 UI 解释"本次精排围绕哪些词"。不引入重型分词依赖。
 *
 * @param text 用户查询。
 * @returns 去重后的检索 token。
 */
function tokenizeForRerank(text: string): string[] {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjk = normalized.match(/[一-鿿]/g) ?? [];
  return [...new Set([...words, ...cjk])];
}

/**
 * 创建 OpenAI 兼容 reranker（生产级精排实现）。
 *
 * 设计动机（WHY）：
 * - 优先调用专用 `/rerank` 端点（cross-encoder 精排，精度最高、延迟最低）。
 * - 若 bridge 不支持 `/rerank`（返回非 2xx），自动回退到 LLM-as-judge rerank：用严格 prompt
 *   让 chat 模型对每个 (query, chunk) 打 0..1 相关分，避免"有 bridge 但无 rerank 端点"时整体失效。
 * - 两层都失败则安全回退为按输入 hybridScore 排序，**绝不抛原始异常**：rerank 是检索链路的
 *   一环，抛异常会破坏整条 grounded answer 流程；结构上保持 `RerankResult.ok` 永远成功返回。
 * - 所有分数写入 `scoreBreakdown.rerankScore` 与 `finalScore`，`finalScore = hybridScore*0.7 + rerankScore*0.3`，
 *   与现有 `HeuristicReranker` 的加权口径一致，便于对比两种 rerank 的命中差异。
 *
 * @param options 端点、key 与模型名。
 * @returns 实现 Reranker 接口的真实精排器。
 */
export function createOpenAiCompatibleReranker(
  options: OpenAiCompatibleRerankerOptions
): Reranker {
  return new OpenAiCompatibleReranker(options);
}

/**
 * OpenAI 兼容 rerank 的运行时实现，组合 `/rerank` 专用端点与 LLM-as-judge 回退。
 */
class OpenAiCompatibleReranker implements Reranker {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * 创建真实 reranker。
   *
   * @param options 端点、key 与模型名。
   */
  public constructor(options: OpenAiCompatibleRerankerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  /**
   * 对候选结果重新排序，写入 rerankScore / finalScore 并按 finalScore 降序重排。
   *
   * 行为要点（安全与结构化）：
   * - 空候选安全返回 ok 空数组，不发起网络请求。
   * - `/rerank` 非 2xx、网络异常或响应字段缺失 → 转 judge 回退。
   * - judge 非 2xx、网络异常或 JSON 解析失败 → 该 chunk 用原 hybridScore（容错）。
   * - 两层都失败 → 整体回退为按输入 hybridScore 排序，不抛异常。
   *
   * @param query 用户查询。
   * @param results 待重排的召回候选（已由 hybrid 检索给出 hybridScore）。
   * @returns 重排后的候选列表；永远 ok。
   */
  public async rerank(query: string, results: readonly RetrievedChunk[]): Promise<RerankResult> {
    const queryTerms = tokenizeForRerank(query);

    // 空候选：直接返回，避免无意义的网络往返。
    if (results.length === 0) {
      return {
        ok: true,
        results: [],
        queryTerms
      };
    }

    const documents = results.map((result) => result.chunk.text ?? "");

    // 第一优先：专用 /rerank 端点。返回 null 表示本层整体失败，需转 judge。
    let tierScores: (number | null)[] | null = await this.attemptRerankEndpoint(query, documents);

    // 第二优先：LLM-as-judge 回退。返回 null 表示本层整体失败，需转 hybrid。
    if (tierScores === null) {
      tierScores = await this.attemptJudge(query, results);
    }

    // 合并：任何层（含整体失败）都确保每层分数兜底为原 hybridScore，绝不出现 undefined。
    const reranked = results
      .map((result, index) => {
        const rawRerankScore = tierScores ? tierScores[index] : null;
        // judge 解析容错：单条缺失时用原 hybridScore，保证排序仍有依据。
        const rerankScore = rawRerankScore === null || rawRerankScore === undefined
          ? result.scoreBreakdown.hybridScore
          : clampScore(rawRerankScore);
        const finalScore = clampScore(result.scoreBreakdown.hybridScore * 0.7 + rerankScore * 0.3);

        return {
          ...result,
          score: finalScore,
          scoreBreakdown: {
            ...result.scoreBreakdown,
            rerankScore,
            finalScore
          }
        };
      })
      .sort((left, right) => {
        const scoreDelta = right.score - left.score;

        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        // finalScore 相同：保持原候选顺序的稳定 tie-break，避免抖动。
        return left.chunk.chunkIndex - right.chunk.chunkIndex;
      })
      .map((result, index) => ({
        ...result,
        rank: index + 1
      }));

    return {
      ok: true,
      results: reranked,
      queryTerms
    };
  }

  /**
   * 尝试专用 `/rerank` 端点，返回每个文档的相关分（按输入顺序），整体失败返回 null。
   *
   * 容错解析：不同实现字段名不同（relevance_score / score），index 可能缺失或越界，
   * 越界或缺失的条目标记为 null（由合并层兜底），但整体无有效项时返回 null 触发 judge。
   *
   * @param query 用户查询。
   * @param documents 候选文档文本。
   * @returns 与 documents 等长、可能含 null 的分数数组；整体失败返回 null。
   */
  private async attemptRerankEndpoint(
    query: string,
    documents: readonly string[]
  ): Promise<(number | null)[] | null> {
    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: [...documents],
          top_n: documents.length
        })
      });

      // 非 2xx：bridge 很可能不支持 /rerank，交给 judge 回退。
      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as { results?: unknown };
      const items = payload?.results;
      if (!Array.isArray(items)) {
        return null;
      }

      const scores: (number | null)[] = documents.map(() => null);
      for (const item of items) {
        const record = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
        const index = typeof record.index === "number" ? record.index : null;
        if (index === null || index < 0 || index >= documents.length) {
          continue;
        }
        const rawScore = record.relevance_score ?? record.score;
        if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
          scores[index] = rawScore;
        }
      }

      // 一条都没解析出来：视为本层失败，触发 judge。
      if (scores.every((score) => score === null)) {
        return null;
      }

      return scores;
    } catch {
      // 网络层异常：结构化收敛为 null，转 judge。
      return null;
    }
  }

  /**
   * 尝试 LLM-as-judge rerank，返回每个文档的相关分（按输入顺序），整体失败返回 null。
   *
   * 容错解析：模型可能返回数组、包一层对象的数组、或带 ```json 围栏的文本；
   * 解析失败或找不到数值数组时返回 null（由合并层整体兜底为 hybridScore）。
   *
   * @param query 用户查询。
   * @param results 待重排候选（用于构造编号 prompt 与对齐长度）。
   * @returns 与 results 等长、可能含 null 的分数数组；整体失败返回 null。
   */
  private async attemptJudge(
    query: string,
    results: readonly RetrievedChunk[]
  ): Promise<(number | null)[] | null> {
    const prompt = buildJudgePrompt(query, results);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "你是一个严谨的检索相关性裁判。只输出一个 JSON 数组，数组长度等于给出的文档数量，" +
                "第 i 个数字表示第 i 个文档与 query 的相关度，范围 0 到 1（1 最相关）。不要输出任何额外文字。"
            },
            {
              role: "user",
              content: prompt
            }
          ]
        })
      });

      // 非 2xx：judge 也不可用，整体回退 hybridScore。
      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return null;
      }

      return parseJudgeScores(content, results.length);
    } catch {
      // 网络层异常：结构化收敛为 null，整体回退 hybridScore。
      return null;
    }
  }
}

/**
 * 构造 LLM-as-judge 的打分 prompt：把 query 与候选文档按编号列出，要求模型按序输出分数。
 *
 * @param query 用户查询。
 * @param results 候选文档。
 * @returns 人类可读的编号 prompt。
 */
function buildJudgePrompt(query: string, results: readonly RetrievedChunk[]): string {
  const numbered = results
    .map((result, index) => `[${index}] ${result.chunk.text ?? ""}`)
    .join("\n\n");
  return `Query: ${query}\n\nDocuments:\n${numbered}\n\n请输出长度为 ${results.length} 的相关度分数数组。`;
}

/**
 * 从 judge 文本中容错解析相关分数数组。
 *
 * 支持裸数组、对象内嵌数组、以及 ```json 围栏；解析失败或找不到数值数组时返回 null。
 * 解析出的数值会被 clamp 到 0..1；长度不足的部分留 null（由合并层兜底 hybridScore）。
 *
 * @param content 模型返回的文本内容。
 * @param count 期望的分数数量（候选文档数）。
 * @returns 与 count 等长的分数数组（可能含 null）；整体不可解析返回 null。
 */
function parseJudgeScores(content: string, count: number): (number | null)[] | null {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  let array: unknown | null = null;
  if (Array.isArray(parsed)) {
    array = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    // 兼容 { scores: [...] } / { relevance: [...] } 等包一层对象的写法。
    const found = Object.values(parsed as Record<string, unknown>).find((value) => Array.isArray(value));
    array = found ?? null;
  }

  if (!Array.isArray(array)) {
    return null;
  }

  const scores: (number | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = array[index];
    scores.push(typeof value === "number" && Number.isFinite(value) ? clampScore(value) : null);
  }
  return scores;
}

/**
 * 根据环境变量创建生产级 reranker（组合开关）。
 *
 * 为什么 env 缺省回退 heuristic：本地开发 / CI / eval 往往没有真实 bridge key，
 * 直接失败会破坏检索链路；回退到 `HeuristicReranker` 可保证可复现、零外部依赖，
 * 真实环境配置 bridge rerank 变量后自动切换为模型精排，无需改代码（依赖倒置）。
 *
 * @returns bridge 启用时返回 OpenAI 兼容 reranker，否则返回 heuristic reranker。
 */
export function createRerankerFromEnv(): Reranker {
  const cfg = readBridgeRerankConfig();
  if (!cfg.enabled) {
    return createHeuristicReranker();
  }
  return createOpenAiCompatibleReranker({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.rerankModel
  });
}
