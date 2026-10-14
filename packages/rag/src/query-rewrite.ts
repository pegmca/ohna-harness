import { readLlmProviderConfig } from "./provider-config.js";

/**
 * query 改写节点（Agentic 检索 / Self-RAG 轻量入口）。
 *
 * WHY（为什么改写提升召回）：
 * 原始用户 query 常与文档语料表述不一致——口语化 vs 术语化、缩写 vs 全称、
 * 单轮短问 vs 文档中的长句描述。直接拿原句做 hybrid 检索容易因字面不匹配而 miss。
 * 改写把 query 扩展成更贴近文档检索语料的扩展问句，并可选地拆分为多个子问题
 * （subQueries）用于多路召回，从而提升向量/关键词检索的命中率。
 * 这是 Self-RAG / Agentic Retrieval 的第一步，编排者在检索前注入本节点即可，
 * 不需要改动既有 retrieval 主链路。
 *
 * WHY（失败必须降级）：
 * 改写是"增强"而非"必需"步骤——LLM 异常、超时或返回无法解析时，必须回退到原 query，
 * 绝不能因增强步骤失败而阻塞主检索链路。因此所有对外 rewriter 都保证不抛异常。
 */

/** 单条改写结果。 */
export interface QueryRewriteResult {
  /** 改写后的检索友好问句；失败时回退为原 query。 */
  rewritten: string;
  /** 可选子问题，用于多路召回；缺失表示不拆分。 */
  subQueries?: string[];
}

/** query rewriter 契约：输入原始 query，输出改写结果。 */
export interface QueryRewriter {
  (query: string): Promise<QueryRewriteResult>;
}

/** 创建 query rewriter 的可选配置：必须提供内部 rewrite 实现。 */
export interface QueryRewriterOptions {
  /**
   * 内部改写实现，真实场景由 createLlmQueryRewriter 提供。
   * 该函数自身可抛错，外层会兜底降级为原 query。
   */
  rewrite: (query: string) => Promise<QueryRewriteResult>;
}

/**
 * 创建 query rewriter 包装。
 *
 * 对外暴露稳定的 rewriter 函数；当内部 rewrite 抛错或返回非法结果时，
 * 安全降级为 `{ rewritten: query }`，保证检索主链路不被增强步骤阻塞。
 *
 * @param options 必须提供 rewrite 实现。
 * @returns 对外稳定的 rewriter 函数。
 */
export function createQueryRewriter(options: QueryRewriterOptions): QueryRewriter {
  return async (query: string): Promise<QueryRewriteResult> => {
    try {
      const result = await options.rewrite(query);
      if (!result || typeof result.rewritten !== "string" || result.rewritten.trim().length === 0) {
        return { rewritten: query };
      }
      return result;
    } catch {
      // 任何内部失败都降级为原 query，不向外抛异常。
      return { rewritten: query };
    }
  };
}

// 原样 rewriter 已降级为测试替身（见 testing.ts），这里仅 re-export 以保持历史导入路径不变。
export { createNoopQueryRewriter } from "./testing.js";

/** 真实 LLM rewrite 工厂配置（OpenAI 兼容 provider 端点）。 */
export interface LlmQueryRewriterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 改写 system prompt：限定只输出 JSON，并要求保留关键实体/数值/期间。 */
const REWRITE_SYSTEM_PROMPT =
  "你是一个金融检索 query 改写器。用户会给出一个原始问题，请把它改写成更适合在金融研报、公告、行业研究向量库中检索的问句：" +
  "补全术语、保留关键实体与数值（如公司名、年份、比率、期间），并尽量贴近文档表述。" +
  "如果原始问题可以分解为多个子问题以获得更全面的召回，请在 subQueries 中列出；否则省略该字段。" +
  "只输出 JSON，格式：{ \"rewritten\": string, \"subQueries\"?: string[] }。";

/**
 * 构造改写 user prompt。
 *
 * @param query 原始问题。
 * @returns 给模型的 user prompt。
 */
function buildRewritePrompt(query: string): string {
  return `原始问题：\n${query}\n\n请按要求输出 JSON。`;
}

/**
 * 容错解析模型返回的改写 JSON，支持 ```json 围栏与散落文本中的对象抽取。
 *
 * @param text 模型返回文本。
 * @returns 解析后的对象，失败返回 null。
 */
function parseRewriteJson(text: string): { rewritten?: unknown; subQueries?: unknown } | null {
  if (!text || text.trim().length === 0) return null;

  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();

  try {
    return JSON.parse(cleaned) as { rewritten?: unknown; subQueries?: unknown };
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as { rewritten?: unknown; subQueries?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 创建真实 LLM query rewriter。
 *
 * 通过 OpenAI 兼容 `/chat/completions` 调用 LLM provider：prompt 要求模型把用户问题改写为检索友好问句，
 * 并可选地拆分子问题用于多路召回，仅输出 JSON。
 * 本函数自身对网络/解析错误返回原 query（不抛），最外层 createQueryRewriter 仍会二次兜底。
 *
 * @param options LLM provider 端点配置（来自 provider-config 的 AIAGENT_LLM_*）。
 * @returns query rewriter 函数。
 */
export function createLlmQueryRewriter(options: LlmQueryRewriterOptions): QueryRewriter {
  const { baseUrl, apiKey, model } = options;

  return async (query: string): Promise<QueryRewriteResult> => {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: REWRITE_SYSTEM_PROMPT },
            { role: "user", content: buildRewritePrompt(query) }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        })
      });

      if (!response.ok) {
        return { rewritten: query };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = parseRewriteJson(content);

      if (!parsed || typeof parsed.rewritten !== "string" || parsed.rewritten.trim().length === 0) {
        return { rewritten: query };
      }

      const subQueries = Array.isArray(parsed.subQueries)
        ? parsed.subQueries.filter((item) => typeof item === "string").map((item) => String(item))
        : undefined;

      return { rewritten: parsed.rewritten, subQueries };
    } catch {
      return { rewritten: query };
    }
  };
}

/**
 * 按 LLM provider 环境变量创建 query rewriter（生产组合开关）。
 *
 * 为什么 env 缺失/禁用时返回 `null` 而不是静默回退 noop：
 * v1.1 改造后，生产检索增强必须显式注入可用的 LLM provider 才启用 Agentic 改写；
 * 缺省回退 noop 会掩盖"查询改写未生效"的配置缺失。禁用时返回 `null`，
 * 由组合根决定是否注入（或显式使用测试替身 `createNoopQueryRewriter`）。
 *
 * @returns provider 启用时返回 LLM 改写器，否则返回 null。
 */
export function createQueryRewriterFromEnv(): QueryRewriter | null {
  const cfg = readLlmProviderConfig();
  if (!cfg.enabled) {
    return null;
  }
  return createQueryRewriter({
    rewrite: createLlmQueryRewriter({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model
    })
  });
}
