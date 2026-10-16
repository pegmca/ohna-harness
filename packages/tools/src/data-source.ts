/**
 * 金融数据源端口（FinancialDataSource）：把工具适配器与具体数据提供方解耦的边界。
 * 工具只依赖本端口，不关心背后是 Tushare / AkShare 还是其他实现；
 * 未来新增真实 provider 时只需实现同一端口，工具代码无需改动。
 *
 * 当前仓库未接入真实后端，因此只提供「未配置即结构化报错」的实现
 * （createUnconfiguredDataSource），真实 provider 适配器将来在 createFinancialDataSourceFromEnv 接入。
 */
import type { MarketSeriesDto } from "@aiagent/types";

/** 行情查询入参：以股票代码定位标的。 */
export interface MarketDataParams {
  ticker: string;
}

/** 单标的行情快照：报价字段 + 日线时序。 */
export interface MarketDataResult {
  ticker: string;
  asOf: string;
  currency: string;
  lastPrice: number;
  changePercent: number;
  source: "real";
  series: MarketSeriesDto;
}

/** 公告检索入参。 */
export interface FilingSearchParams {
  ticker: string;
  query: string;
}

/** 单条公告命中项。 */
export interface FilingItem {
  title: string;
  period: string;
  snippet: string;
  source: "real";
}

/** 公告检索结果。 */
export interface FilingSearchResult {
  ticker: string;
  query: string;
  filings: FilingItem[];
}

/** 财务指标查询入参。 */
export interface FinancialMetricParams {
  ticker: string;
  metrics?: Array<"net_profit" | "roe">;
}

/** 单指标数值与单位。 */
export interface FinancialMetricValue {
  value: number;
  unit: string;
}

/** 财务指标结果：净利润与 ROE。 */
export interface FinancialMetricResult {
  ticker: string;
  period: string;
  metrics: {
    net_profit: FinancialMetricValue;
    roe: FinancialMetricValue & { unit: "%" };
  };
  source: "real";
}

/**
 * 金融数据源端口：工具适配器通过该接口获取行情、公告与财务指标。
 * 所有方法返回 Promise，便于真实 provider 走网络或数据库 I/O。
 */
export interface FinancialDataSource {
  /** 当前是否已有可用真实后端；未配置时工具应返回结构化错误而非崩溃。 */
  isConfigured(): boolean;
  /** 获取标的最新行情与日线时序。 */
  getMarketData(params: MarketDataParams): Promise<MarketDataResult>;
  /** 检索标的相关的公告片段。 */
  searchFilings(params: FilingSearchParams): Promise<FilingSearchResult>;
  /** 获取标的的财务指标（净利润、ROE 等）。 */
  getFinancialMetrics(params: FinancialMetricParams): Promise<FinancialMetricResult>;
}

/** 数据源未配置时抛出的错误；工具捕获后转为结构化结果回喂模型。 */
export class DataSourceNotConfiguredError extends Error {
  constructor(message = "金融数据源未配置") {
    super(message);
    this.name = "DataSourceNotConfiguredError";
  }
}

/**
 * 工具在未配置数据源时回喂模型的统一提示文案。
 * 说明「尚未接入后端」而非「执行失败」，引导调用方配置 AIAGENT_DATA_SOURCE 与凭据。
 */
export const DATA_SOURCE_NOT_CONFIGURED_MESSAGE =
  "金融数据源未配置：请在 .env 提供 AIAGENT_DATA_SOURCE 与对应凭据，或稍后接入真实数据源。";

/**
 * 创建未配置的数据源实现：isConfigured 恒为 false，每个领域方法直接抛 DataSourceNotConfiguredError。
 * 数据源未接入时返回结构化错误，交由调用方决定降级策略，而不是让整个 run 崩溃。
 *
 * @returns 满足 FinancialDataSource 端口但未配置的实现。
 */
export function createUnconfiguredDataSource(): FinancialDataSource {
  const fail = (): never => {
    throw new DataSourceNotConfiguredError();
  };

  return {
    isConfigured: () => false,
    getMarketData: fail,
    searchFilings: fail,
    getFinancialMetrics: fail,
  };
}

/**
 * 依据环境变量构造数据源：当前尚未接入真实 provider，统一返回未配置实现。
 *
 * 接入点（将来扩展）：读取 AIAGENT_DATA_SOURCE 等环境变量，
 * 按 provider 名称（如 tushare / akshare）构造对应的真实适配器并 return；
 * 该分支是真实后端的唯一入口，工具层与端口层均无需改动。
 *
 * @returns 已按环境配置构造的 FinancialDataSource。
 */
export function createFinancialDataSourceFromEnv(): FinancialDataSource {
  return createUnconfiguredDataSource();
}
