import { z } from "zod";
import { defineAgentTool } from "../agent-tool.js";
import type { AgentTool } from "../types.js";

export const filingSearchMockInputSchema = z.object({
  ticker: z.string().min(1, "ticker is required"),
  query: z.string().min(1, "query is required")
});

export const filingSearchMockOutputSchema = z.object({
  ticker: z.string(),
  query: z.string(),
  filings: z.array(
    z.object({
      title: z.string(),
      period: z.string(),
      snippet: z.string(),
      source: z.literal("mock")
    })
  )
});

export type FilingSearchMockInput = z.infer<typeof filingSearchMockInputSchema>;
export type FilingSearchMockOutput = z.infer<typeof filingSearchMockOutputSchema>;

export const filingSearchMockTool: AgentTool<typeof filingSearchMockInputSchema, FilingSearchMockOutput> = defineAgentTool({
  name: "filing_search_mock",
  description: "Search stable mock filing snippets for a ticker and natural-language query.",
  label: "Filing Search (Mock)",
  parameters: filingSearchMockInputSchema,
  outputSchema: filingSearchMockOutputSchema,
  /**
   * 返回稳定公告片段，便于验收 RAG/工具链路之前先验证工具基础设施。
   *
   * @param input 公告检索参数。
   * @returns 命中的 mock 公告片段列表。
   */
  execute(input) {
    return {
      ticker: input.ticker,
      query: input.query,
      filings: [
        {
          title: "平安银行 2025 年年度报告",
          period: "2025A",
          snippet:
            "资产质量保持稳健，不良贷款率较上年末下降，拨备覆盖率维持在审慎水平，零售风险处置节奏符合管理层预期。",
          source: "mock"
        }
      ]
    };
  }
});
