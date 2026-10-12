import type { IngestedFilingDocumentDto } from "@aiagent/types";
import type { RagChunk } from "./types.js";
import { readBridgeConfig } from "./bridge-config.js";

/**
 * Contextual Retrieval 前缀生成器选项。
 *
 * 调用方注入一个"根据文档生成上下文前缀"的异步函数；该函数应产出文档级语境
 * （如标题、各级 heading、摘要），用于拼接到每个 chunk 文本之前。
 */
export interface ContextualEnricherOptions {
  generateContextPrefix: (document: IngestedFilingDocumentDto) => Promise<string>;
}

/**
 * 创建 Contextual Retrieval chunk enricher（Anthropic Contextual Retrieval 思路）。
 *
 * WHY 拼接文档级上下文比调大 chunk size 收益更高：
 * 单独一个 chunk 往往丢失"它属于哪篇文档、哪个章节、讲什么"的全局语境，embedding
 * 只能捕获片段字面语义；在 chunk 文本前拼接来源文档的标题、各级 heading 与摘要，
 * 等于给每个向量补上"全局坐标"，检索召回更准，且不影响 chunk 原文的完整性与可引用性。
 *
 * 健壮性（优雅降级）：generateContextPrefix 抛异常或返回空串时，该 chunk 保持原样，
 * 绝不把异常抛给调用方——避免单一文档的 LLM 调用失败拖垮整批 ingest。
 *
 * @param options 注入的文档级上下文前缀生成器。
 * @returns (document, chunks) => 注入前缀后的新 RagChunk[]（不原地修改入参）。
 */
export function createContextualChunkEnricher(
  options: ContextualEnricherOptions
): (document: IngestedFilingDocumentDto, chunks: RagChunk[]) => Promise<RagChunk[]> {
  return async (document, chunks) => {
    const enriched: RagChunk[] = [];

    for (const chunk of chunks) {
      try {
        const prefix = (await options.generateContextPrefix(document)).trim();

        // 空前缀视为无上下文可用，保持 chunk 原样（降级而非拼接空行噪音）。
        if (prefix.length === 0) {
          enriched.push(chunk);
          continue;
        }

        enriched.push({
          ...chunk,
          text: `${prefix}\n\n${chunk.text}`
        });
      } catch {
        // 生成器异常时优雅降级：保留原 chunk，不让单文档失败拖垮整批。
        enriched.push(chunk);
      }
    }

    return enriched;
  };
}

/**
 * 创建恒等 enricher：原样返回 chunks。
 *
 * 用于关闭 Contextual Retrieval 特性或作为单测基线；语义等价于"未注入任何上下文前缀"。
 *
 * @returns 不改变任何 chunk 的 enricher。
 */
export function createNoopContextualEnricher(): (
  document: IngestedFilingDocumentDto,
  chunks: RagChunk[]
) => Promise<RagChunk[]> {
  return async (_document, chunks) => chunks;
}

/**
 * 真实 LLM 上下文前缀生成器选项：走 OpenAI 兼容 /chat/completions 端点。
 */
export interface LlmContextPrefixGeneratorOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 创建基于真实 LLM 的文档级上下文前缀生成器。
 *
 * 调用 `${baseUrl}/chat/completions`，让模型基于文档标题与各级 heading 生成 ≤2 句中文
 * 上下文前缀。WHY 失败要降级：LLM 调用属于外部依赖，偶发超时/限流不应阻断 ingestion；
 * 失败时返回空串，交由 enricher 降级为 chunk 原样。本函数绝不向外抛出原始异常。
 *
 * @param options 端点 baseUrl、apiKey 与 model。
 * @returns 可注入 createContextualChunkEnricher 的 generateContextPrefix。
 */
export function createLlmContextPrefixGenerator(
  options: LlmContextPrefixGeneratorOptions
): (document: IngestedFilingDocumentDto) => Promise<string> {
  return async (document) => {
    try {
      const headings = collectHeadings(document);
      const prompt =
        "你是检索增强系统中的上下文助手。请基于以下文档信息，生成不超过 2 句中文，" +
        "说明该文档的整体主题与要点，用于给文本片段补充文档级语境：\n" +
        `标题：${document.title}\n${headings}`;

      const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 120,
          temperature: 0
        })
      });

      if (!response.ok) {
        return "";
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";

      return content.length === 0 ? "" : content;
    } catch {
      // 网络/解析失败一律降级为空串，交给 enricher 保持 chunk 原样。
      return "";
    }
  };
}

/**
 * 从文档 blocks 的 heading 线索聚合出可放进 prompt 的章节摘要（去重、截断以控制 token）。
 *
 * @param document 已 ingestion 的文档。
 * @returns 章节 heading 列表文本。
 */
function collectHeadings(document: IngestedFilingDocumentDto): string {
  const headings = document.blocks
    .map((block) => block.heading)
    .filter((heading, index, arr): heading is string => Boolean(heading) && arr.indexOf(heading) === index)
    .slice(0, 8);

  return headings.length > 0 ? `章节：${headings.join("；")}` : "";
}

/**
 * 按环境变量创建 Contextual Retrieval enricher（生产组合开关）。
 *
 * 为什么 env 缺省回退 noop：本地 / CI / eval 往往没有真实 bridge key，直接让 ingest 走 LLM
 * 会拖慢且依赖网络；缺省 noop 保持 chunk 原样，配置 bridge 后自动启用文档级上下文前缀，无需改代码。
 *
 * @returns bridge 启用时返回 LLM 前缀生成 enricher，否则返回恒等 enricher。
 */
export function createContextEnricherFromEnv(): (
  document: IngestedFilingDocumentDto,
  chunks: RagChunk[]
) => Promise<RagChunk[]> {
  const cfg = readBridgeConfig();
  if (!cfg.enabled) {
    return createNoopContextualEnricher();
  }
  return createContextualChunkEnricher({
    generateContextPrefix: createLlmContextPrefixGenerator({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model
    })
  });
}
