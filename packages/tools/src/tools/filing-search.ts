import { z } from "zod";
import type { AgentTool } from "../types.js";
import {
  DATA_SOURCE_NOT_CONFIGURED_MESSAGE,
  type FinancialDataSource,
  type FilingSearchResult,
} from "../data-source.js";

export const filingSearchInputSchema = z.object({
  ticker: z.string().min(1, "ticker is required"),
  query: z.string().min(1, "query is required"),
});

export type FilingSearchInput = z.infer<typeof filingSearchInputSchema>;

export const filingSearchOutputSchema = z.object({
  ticker: z.string(),
  query: z.string(),
  filings: z.array(
    z.object({
      title: z.string(),
      period: z.string(),
      snippet: z.string(),
      source: z.literal("real"),
    }),
  ),
});

export type FilingSearchOutput = z.infer<typeof filingSearchOutputSchema>;

/**
 * 构造公告检索工具适配器：把 LLM 的工具调用转发到 FinancialDataSource 端口。
 * 数据源未配置或查询异常时不向上抛，而是返回结构化错误结果，交由 loop 把提示文本回喂模型。
 *
 * @param dataSource 金融数据源端口实现；缺省由调用方传入未配置实现。
 * @returns 可直接注册到 registry 的 AgentTool。
 */
export function createFilingSearchTool(
  dataSource: FinancialDataSource,
): AgentTool<typeof filingSearchInputSchema, unknown> {
  return {
    name: "filing_search",
    description: "Search filing snippets for a ticker and natural-language query from the configured financial data source.",
    label: "Filing Search",
    parameters: filingSearchInputSchema,
    source: "real",
    /**
     * 校验入参后调用数据源端口；未配置或失败返回结构化错误，不抛异常中断 run。
     *
     * @param _toolCallId 工具调用 id（本层不消费）。
     * @param params 已通过 zod 校验的公告检索参数。
     * @returns 公告结构化结果或错误结果。
     */
    async execute(_toolCallId, params) {
      const parsed = filingSearchInputSchema.safeParse(params);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid arguments for tool: filing_search"), {
          code: "validation_error",
          details: { issues: parsed.error.issues },
        });
      }

      try {
        const output: FilingSearchResult = await dataSource.searchFilings({
          ticker: parsed.data.ticker,
          query: parsed.data.query,
        });
        const validated = filingSearchOutputSchema.safeParse(output);
        if (!validated.success) {
          return {
            content: [{ type: "text", text: "数据源返回的数据结构异常，无法序列化为工具结果。" }],
            isError: true,
            details: { issues: validated.error.issues },
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(validated.data, null, 2) }],
          details: validated.data,
        };
      } catch (error) {
        // 数据源未接入或查询失败：返回结构化错误，交由调用方决定降级策略。
        return {
          content: [{ type: "text", text: DATA_SOURCE_NOT_CONFIGURED_MESSAGE }],
          isError: true,
          details: { kind: "data_source_error", error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  };
}
