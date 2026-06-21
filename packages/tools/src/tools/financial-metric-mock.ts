import { z } from "zod";
import type { Tool } from "../types.js";

export const financialMetricMockInputSchema = z.object({
  ticker: z.string().min(1, "ticker is required"),
  metrics: z.array(z.enum(["net_profit", "roe"])).min(1).optional()
});

export const financialMetricMockOutputSchema = z.object({
  ticker: z.string(),
  period: z.string(),
  metrics: z.object({
    net_profit: z.object({
      value: z.number(),
      unit: z.string()
    }),
    roe: z.object({
      value: z.number(),
      unit: z.literal("%")
    })
  }),
  source: z.literal("mock")
});

export type FinancialMetricMockInput = z.infer<typeof financialMetricMockInputSchema>;
export type FinancialMetricMockOutput = z.infer<typeof financialMetricMockOutputSchema>;

const MOCK_FINANCIAL_METRICS: Record<string, Omit<FinancialMetricMockOutput, "ticker">> = {
  "000001.SZ": {
    period: "2026Q1",
    metrics: {
      net_profit: {
        value: 14932000000,
        unit: "CNY"
      },
      roe: {
        value: 3.42,
        unit: "%"
      }
    },
    source: "mock"
  }
};

export const financialMetricMockTool: Tool<FinancialMetricMockInput, FinancialMetricMockOutput> = {
  name: "financial_metric_mock",
  description: "Return stable mock financial metrics for a ticker.",
  inputSchema: financialMetricMockInputSchema,
  outputSchema: financialMetricMockOutputSchema,
  /**
   * 返回稳定财务指标，缺失 ticker 数据时交给 executor 转成结构化错误。
   *
   * @param input 财务指标查询参数。
   * @returns 最近一期净利润和 ROE mock 数据。
   */
  execute(input) {
    const data = MOCK_FINANCIAL_METRICS[input.ticker];

    if (!data) {
      throw new Error(`No mock financial metrics for ticker: ${input.ticker}`);
    }

    return {
      ticker: input.ticker,
      ...data
    };
  }
};
