import { z } from "zod";
import type { Tool } from "../types.js";

export const marketDataMockInputSchema = z.object({
  ticker: z.string().min(1, "ticker is required")
});

export const marketDataMockOutputSchema = z.object({
  ticker: z.string(),
  asOf: z.string(),
  currency: z.string(),
  lastPrice: z.number(),
  changePercent: z.number(),
  source: z.literal("mock")
});

export type MarketDataMockInput = z.infer<typeof marketDataMockInputSchema>;
export type MarketDataMockOutput = z.infer<typeof marketDataMockOutputSchema>;

const MOCK_MARKET_DATA: Record<string, Omit<MarketDataMockOutput, "ticker">> = {
  "000001.SZ": {
    asOf: "2026-06-19T15:00:00+08:00",
    currency: "CNY",
    lastPrice: 10.85,
    changePercent: 0.74,
    source: "mock"
  }
};

export const marketDataMockTool: Tool<MarketDataMockInput, MarketDataMockOutput> = {
  name: "market_data_mock",
  description: "Return stable mock latest market data for a ticker.",
  inputSchema: marketDataMockInputSchema,
  outputSchema: marketDataMockOutputSchema,
  /**
   * 返回稳定 mock 行情，缺失 ticker 数据时交给 executor 转成结构化错误。
   *
   * @param input 行情查询参数。
   * @returns 最近价格 mock 数据。
   */
  execute(input) {
    const data = MOCK_MARKET_DATA[input.ticker];

    if (!data) {
      throw new Error(`No mock market data for ticker: ${input.ticker}`);
    }

    return {
      ticker: input.ticker,
      ...data
    };
  }
};
