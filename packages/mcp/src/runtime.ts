import {
  createDataSourceRuntime,
  createDeterministicMockEmbeddingClient,
  createInMemoryRagDocumentRepository,
  createInMemoryVectorStoreFactory
} from "@aiagent/rag";
import { createDefaultToolRegistry } from "@aiagent/tools";
import type {
  FinancialMetricsInput,
  FinancialMetricsOutput,
  MarketDataInput,
  MarketDataOutput,
  SearchFilingsInput,
  SearchFilingsOutput
} from "./schemas.js";

const COMPANY_ALIASES: Record<string, { companyId: string; companyName: string }> = {
  "000001.SZ": { companyId: "000001.SZ", companyName: "平安银行" },
  "平安银行": { companyId: "000001.SZ", companyName: "平安银行" }
};

const DEMO_FILING = `# 平安银行 2025 年年度报告

## 资产质量

2025 年末不良贷款率为 1.02%，较上年末下降 0.04 个百分点。拨备覆盖率为 251.36%，风险抵补能力保持稳健。

## 盈利能力

2025 年归属于母公司股东的净利润保持稳定，净资产收益率继续反映银行资本使用效率。

## 风险提示

宏观经济波动、房地产行业风险与零售贷款质量变化仍可能影响未来经营表现。`;

export interface McpFinancialToolRuntime {
  searchFilings(input: SearchFilingsInput): Promise<SearchFilingsOutput>;
  getFinancialMetrics(input: FinancialMetricsInput): Promise<FinancialMetricsOutput>;
  getMarketData(input: MarketDataInput): Promise<MarketDataOutput>;
}

/**
 * 创建金融研究 MCP 工具 runtime，使协议注册层只负责 MCP 消息映射。
 *
 * @returns 三个金融研究工具的结构化执行入口。
 */
export function createMcpFinancialToolRuntime(): McpFinancialToolRuntime {
  const ragRuntime = createDataSourceRuntime({
    repository: createInMemoryRagDocumentRepository(),
    embeddingClient: createDeterministicMockEmbeddingClient(),
    vectorStoreFactory: createInMemoryVectorStoreFactory()
  });
  const toolRegistry = createDefaultToolRegistry();
  let seedPromise: Promise<void> | undefined;

  /**
   * 首次检索前装载稳定 demo 公告，避免测试依赖网络或外部数据库。
   *
   * @returns 公告完成索引后的 Promise。
   */
  function ensureDemoFiling(): Promise<void> {
    seedPromise ??= ragRuntime.ingest({
      source: "mock://filings/000001.SZ/2025-annual.md",
      fileName: "000001.SZ-2025-annual.md",
      contentType: "text/markdown",
      content: DEMO_FILING
    }).then((result) => {
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    });
    return seedPromise;
  }

  return {
    /**
     * 使用现有 RAG runtime 检索 demo 公告，并保留标准 citation 与 score。
     *
     * @param input 公司、查询、数量和可选时间范围。
     * @returns 结构化公告片段；失败不会向 MCP 调用方抛异常。
     */
    async searchFilings(input) {
      try {
        const company = resolveCompany(input.companyId, input.companyName);
        if (!company) {
          return failure("company_not_found", "No mock filing data for the requested company.", input);
        }
        await ensureDemoFiling();
        const result = await ragRuntime.search(input.query, { topK: input.topK, mode: "hybrid" });
        if (!result.ok) {
          return failure(result.error.code, result.error.message, result.error.details);
        }
        return {
          ok: true,
          data: {
            ...company,
            snippets: result.data.results.map((item) => ({
              text: item.text,
              score: item.score,
              citation: item.citation
            })),
            source: "mock_rag_runtime"
          }
        };
      } catch (error) {
        return failure("search_filings_failed", toErrorMessage(error));
      }
    },

    /**
     * 调用 tools registry 的 mock 指标工具，并投影为 MCP 稳定数组结构。
     *
     * @param input 公司、指标列表和可选时间范围。
     * @returns 每个指标的 value、period、unit 和 source。
     */
    async getFinancialMetrics(input) {
      const company = resolveCompany(input.companyId, input.companyName);
      if (!company) {
        return failure("company_not_found", "No mock financial metrics for the requested company.", input);
      }
      const result = await toolRegistry.execute("financial_metric_mock", {
        ticker: company.companyId,
        metrics: input.metrics
      });
      if (!result.ok) {
        return failure(result.error.code, result.error.message, result.error.details);
      }
      const output = result.result as {
        period: string;
        metrics: Record<"net_profit" | "roe", { value: number; unit: string }>;
        source: "mock";
      };
      return {
        ok: true,
        data: {
          ...company,
          metrics: input.metrics.map((metric) => ({
            metric,
            value: output.metrics[metric].value,
            period: output.period,
            unit: output.metrics[metric].unit,
            source: output.source
          }))
        }
      };
    },

    /**
     * 调用 tools registry 的 mock 行情工具，并按 fields 输出调用方所需字段。
     *
     * @param input ticker、查询范围和字段列表。
     * @returns 结构化行情摘要；prices/volume 是明确标记的 mock 衍生值。
     */
    async getMarketData(input) {
      const result = await toolRegistry.execute("market_data_mock", { ticker: input.ticker });
      if (!result.ok) {
        return failure(result.error.code, result.error.message, result.error.details);
      }
      const output = result.result as {
        asOf: string; currency: string; lastPrice: number; changePercent: number; source: "mock";
        series: import("@aiagent/types").MarketSeriesDto;
      };
      const requested = new Set(input.fields);
      return {
        ok: true,
        data: {
          ticker: input.ticker,
          range: input.range,
          asOf: output.asOf,
          currency: output.currency,
          ...(requested.has("prices") ? { prices: [{ timestamp: output.asOf, value: output.lastPrice }] } : {}),
          ...(requested.has("returns") ? { returns: output.changePercent } : {}),
          ...(requested.has("volume") ? { volume: 102400000 } : {}),
          ...(requested.has("summary") ? { summary: { lastPrice: output.lastPrice, changePercent: output.changePercent } } : {}),
          ...(requested.has("ohlcv") ? { series: output.series } : {}),
          source: output.source
        }
      };
    }
  };
}

/**
 * 把公司代码或名称归一化到当前 mock 数据集的公司标识。
 *
 * @param companyId 可选公司代码。
 * @param companyName 可选公司名称。
 * @returns 已知公司映射；无匹配时返回 undefined。
 */
function resolveCompany(companyId?: string, companyName?: string) {
  return (companyId && COMPANY_ALIASES[companyId]) || (companyName && COMPANY_ALIASES[companyName]);
}

/**
 * 创建所有 MCP 工具共用的结构化失败结果。
 *
 * @param code 稳定错误码。
 * @param message 面向调用方的错误说明。
 * @param details 可选诊断上下文。
 * @returns 不抛异常的失败 envelope。
 */
function failure(code: string, message: string, details?: unknown): { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(isRecord(details) ? { details } : {})
    }
  };
}

/**
 * 判断未知值能否安全写入结构化错误 details。
 *
 * @param value 未知诊断值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 将未知异常安全转换为消息，避免泄漏原始异常对象。
 *
 * @param error 未知异常。
 * @returns 可序列化错误消息。
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown MCP tool error.";
}
