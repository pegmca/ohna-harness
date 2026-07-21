import { z } from "zod";

const timeRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional()
}).optional();

/** 公告检索输入兼容公司代码/名称，并限制 topK，防止一次返回过多上下文。 */
export const searchFilingsInputSchema = z.object({
  companyId: z.string().min(1).optional(),
  companyName: z.string().min(1).optional(),
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).default(5),
  timeRange: timeRangeSchema
}).refine((input) => input.companyId !== undefined || input.companyName !== undefined, {
  message: "companyId or companyName is required"
});

/** Citation schema 直接对齐现有 RAG DTO 的来源、位置与置信度字段。 */
export const citationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  source: z.string(),
  heading: z.string().optional(),
  chunkIndex: z.number().int(),
  quote: z.string(),
  pageNumber: z.number().optional(),
  confidence: z.number()
});

/** 公告片段同时携带文本、检索分数和可追溯引用。 */
export const filingSnippetSchema = z.object({
  text: z.string(),
  score: z.number(),
  citation: citationSchema
});

/** 财务指标输入只开放当前 mock tool 已稳定支持的指标枚举。 */
export const financialMetricsInputSchema = z.object({
  companyId: z.string().min(1).optional(),
  companyName: z.string().min(1).optional(),
  metrics: z.array(z.enum(["net_profit", "roe"])).min(1),
  timeRange: timeRangeSchema
}).refine((input) => input.companyId !== undefined || input.companyName !== undefined, {
  message: "companyId or companyName is required"
});

/** 行情输入通过 fields 显式控制返回内容，为后续真实时序数据保留 range。 */
export const marketDataInputSchema = z.object({
  ticker: z.string().min(1),
  range: z.string().min(1).default("1d"),
  fields: z.array(z.enum(["prices", "returns", "volume", "summary", "ohlcv"])).min(1).default(["summary"])
});

/** 所有 MCP tool 共享稳定错误结构，避免调用方解析原始异常文本。 */
export const mcpErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional()
});

/** 公告检索输出保留 RAG snippets、citations、scores 和 mock 来源标记。 */
export const searchFilingsOutputSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    companyId: z.string(),
    companyName: z.string().optional(),
    snippets: z.array(filingSnippetSchema),
    source: z.literal("mock_rag_runtime")
  }).optional(),
  error: mcpErrorSchema.optional()
});

/** 财务指标输出把 map 投影为逐项 metric/value/period/unit/source 记录。 */
export const financialMetricsOutputSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    companyId: z.string(),
    companyName: z.string().optional(),
    metrics: z.array(z.object({
      metric: z.enum(["net_profit", "roe"]),
      value: z.number(),
      period: z.string(),
      unit: z.string(),
      source: z.literal("mock")
    }))
  }).optional(),
  error: mcpErrorSchema.optional()
});

/** 行情输出按请求字段返回可选序列/摘要，并显式标记 mock 数据源。 */
export const marketDataOutputSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    ticker: z.string(),
    range: z.string(),
    asOf: z.string(),
    currency: z.string(),
    prices: z.array(z.object({ timestamp: z.string(), value: z.number() })).optional(),
    returns: z.number().optional(),
    volume: z.number().optional(),
    summary: z.object({ lastPrice: z.number(), changePercent: z.number() }).optional(),
    series: z.object({
      ticker: z.string(), exchange: z.string(), currency: z.string(), timezone: z.string(),
      interval: z.literal("1d"), range: z.literal("3m"), source: z.literal("mock"), asOf: z.string(),
      bars: z.array(z.object({ time: z.string(), open: z.number(), high: z.number(), low: z.number(), close: z.number(), volume: z.number() }))
    }).optional(),
    source: z.literal("mock")
  }).optional(),
  error: mcpErrorSchema.optional()
});

export type SearchFilingsInput = z.infer<typeof searchFilingsInputSchema>;
export type SearchFilingsOutput = z.infer<typeof searchFilingsOutputSchema>;
export type FinancialMetricsInput = z.infer<typeof financialMetricsInputSchema>;
export type FinancialMetricsOutput = z.infer<typeof financialMetricsOutputSchema>;
export type MarketDataInput = z.infer<typeof marketDataInputSchema>;
export type MarketDataOutput = z.infer<typeof marketDataOutputSchema>;
