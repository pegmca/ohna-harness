import { z } from "zod";
import type { Tool } from "../types.js";
import type { MarketSeriesDto } from "@aiagent/types";

export const marketDataMockInputSchema = z.object({
  ticker: z.string().min(1, "ticker is required")
});

export const marketDataMockOutputSchema = z.object({
  ticker: z.string(),
  asOf: z.string(),
  currency: z.string(),
  lastPrice: z.number(),
  changePercent: z.number(),
  source: z.literal("mock"),
  series: z.object({
    ticker: z.string(),
    exchange: z.string(),
    currency: z.string(),
    timezone: z.string(),
    interval: z.literal("1d"),
    range: z.literal("3m"),
    source: z.literal("mock"),
    asOf: z.string(),
    bars: z.array(z.object({
      time: z.string(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
      volume: z.number().nonnegative()
    }))
  })
});

export type MarketDataMockInput = z.infer<typeof marketDataMockInputSchema>;
export type MarketDataMockOutput = z.infer<typeof marketDataMockOutputSchema>;

const MOCK_MARKET_DATA: Record<string, Omit<MarketDataMockOutput, "ticker" | "series">> = {
  "000001.SZ": {
    asOf: "2026-06-19T15:00:00+08:00",
    currency: "CNY",
    lastPrice: 10.85,
    changePercent: 0.74,
    source: "mock"
  }
};

/**
 * 生成稳定且满足 OHLC 不变量的 60 个交易日 mock 数据。
 *
 * @param ticker 股票代码。
 * @param asOf 数据截止时间。
 * @returns 可由真实 provider 替换的行情时序。
 */
function createMockSeries(ticker: string, asOf: string): MarketSeriesDto {
  const bars = Array.from({ length: 60 }, (_, index) => {
    const day = new Date("2026-03-23T00:00:00+08:00");
    day.setUTCDate(day.getUTCDate() + index);
    const center = 9.8 + index * 0.017 + Math.sin(index / 4) * 0.32;
    const open = Number((center + Math.sin(index) * 0.08).toFixed(2));
    const close = Number((center + Math.cos(index / 2) * 0.1).toFixed(2));
    return {
      time: day.toISOString().slice(0, 10),
      open,
      high: Number((Math.max(open, close) + 0.12 + (index % 3) * 0.02).toFixed(2)),
      low: Number((Math.min(open, close) - 0.11 - (index % 2) * 0.02).toFixed(2)),
      close,
      volume: 78_000_000 + index * 530_000 + (index % 7) * 1_700_000
    };
  });

  return {
    ticker,
    exchange: "SZSE",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    interval: "1d",
    range: "3m",
    source: "mock",
    asOf,
    bars
  };
}

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
      ...data,
      series: createMockSeries(input.ticker, data.asOf)
    };
  }
};
