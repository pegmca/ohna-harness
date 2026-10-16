// 测试替身：离线确定性金融数据源。
// 仅用于 packages/mcp 的行为测试注入，使三个真实数据工具（market_data / filing_search / financial_metric）
// 返回确定性 canned 数据而非「未配置」结构化错误。它不是生产 mock 模式，生产路径在真实数据源未接入时
// 仍返回 isError，本替身仅由 stdio 入口在 AIAGENT_MCP_FAKE_DATA_SOURCE 环境变量指向时动态加载。

/**
 * 创建测试用假金融数据源。
 *
 * 设计要点：
 * - isConfigured() 恒为 true，模拟「已接入真实后端」的状态，让工具适配器走正常数据分支。
 * - 三个领域方法返回结构稳定、与 @aiagent/tools 的 zod 输出 schema 完全对齐的 canned 数据，无需真实网络。
 * - 对未知标的（ticker === "UNKNOWN"）主动抛错，用于还原「tool runtime 暴露结构化错误」这一行为测试。
 *
 * @returns 满足 FinancialDataSource 端口的测试替身实现。
 */
export async function createFakeFinancialDataSource() {
  return {
    /** 测试替身始终视为已配置，驱动工具走真实数据分支。 */
    isConfigured: () => true,

    /**
     * 返回确定性的单标的行情快照与日线时序。
     *
     * @param params.ticker 标的代码；UNKNOWN 视为未找到标的并抛错。
     * @returns 对齐 MarketDataResult 的 canned 行情。
     */
    async getMarketData({ ticker }) {
      if (ticker === "UNKNOWN") {
        throw new Error("未找到该标的的行情数据");
      }
      return {
        ticker,
        asOf: "2026-03-31T15:00:00+08:00",
        currency: "CNY",
        lastPrice: 11.52,
        changePercent: 1.23,
        source: "real",
        series: {
          ticker,
          exchange: "SZSE",
          currency: "CNY",
          timezone: "Asia/Shanghai",
          interval: "1d",
          range: "3m",
          source: "real",
          asOf: "2026-03-31T15:00:00+08:00",
          bars: [
            { time: "2026-03-27", open: 11.3, high: 11.55, low: 11.25, close: 11.4, volume: 98200000 },
            { time: "2026-03-30", open: 11.42, high: 11.6, low: 11.38, close: 11.48, volume: 101200000 },
            { time: "2026-03-31", open: 11.49, high: 11.62, low: 11.44, close: 11.52, volume: 102400000 }
          ]
        }
      };
    },

    /**
     * 返回确定性的公告命中列表。
     *
     * @param params.ticker 标的代码。
     * @param params.query 检索关键词。
     * @returns 对齐 FilingSearchResult 的 canned 公告。
     */
    async searchFilings({ ticker, query }) {
      return {
        ticker,
        query,
        filings: [
          {
            title: "2025 年年度报告",
            period: "2025",
            snippet: "2025 年末不良贷款率为 1.02%，拨备覆盖率为 251.36%。",
            source: "real"
          },
          {
            title: "2026 年第一季度报告",
            period: "2026Q1",
            snippet: "一季度归属于母公司股东的净利润保持稳定，净资产收益率延续稳健。",
            source: "real"
          }
        ]
      };
    },

    /**
     * 返回确定性的财务指标（净利润、ROE）。
     *
     * @param params.ticker 标的代码。
     * @returns 对齐 FinancialMetricResult 的 canned 指标。
     */
    async getFinancialMetrics({ ticker }) {
      return {
        ticker,
        period: "2026Q1",
        metrics: {
          net_profit: { value: 1234560000, unit: "CNY" },
          roe: { value: 12.34, unit: "%" }
        },
        source: "real"
      };
    }
  };
}
