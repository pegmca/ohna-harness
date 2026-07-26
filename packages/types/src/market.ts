import type { ISODateTimeString } from "./primitives.js";

/** 单根 K 线的稳定行情传输结构。 */
export interface MarketBarDto {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 行情时序 contract 与 provider 解耦，UI 不依赖具体工具实现。 */
export interface MarketSeriesDto {
  ticker: string;
  exchange: string;
  currency: string;
  timezone: string;
  interval: "1d";
  range: "3m";
  source: "mock";
  asOf: ISODateTimeString;
  bars: MarketBarDto[];
}
