import type { MarketSeriesDto } from "@aiagent/types";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";

/**
 * 渲染 A 股红涨绿跌的 K 线与成交量；组件只消费稳定行情 contract。
 *
 * @param props 行情序列。
 * @returns K 线图容器。
 */
export function MarketCandlestickChart(props: { series: MarketSeriesDto }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const styles = getComputedStyle(document.documentElement);
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 340,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: styles.getPropertyValue("--md-color-text-muted").trim()
      },
      grid: {
        vertLines: { color: styles.getPropertyValue("--md-color-border-subtle").trim() },
        horzLines: { color: styles.getPropertyValue("--md-color-border-subtle").trim() }
      },
      rightPriceScale: { borderColor: styles.getPropertyValue("--md-color-border").trim() },
      timeScale: { borderColor: styles.getPropertyValue("--md-color-border").trim() }
    });
    const upColor = styles.getPropertyValue("--md-market-up").trim();
    const downColor = styles.getPropertyValue("--md-market-down").trim();
    const candles = chart.addSeries(CandlestickSeries, {
      upColor, downColor, borderUpColor: upColor, borderDownColor: downColor, wickUpColor: upColor, wickDownColor: downColor
    });
    candles.setData(props.series.bars.map((bar) => ({
      time: bar.time as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close
    })));
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(props.series.bars.map((bar) => ({
      time: bar.time as Time,
      value: bar.volume,
      color: bar.close >= bar.open ? `${upColor}66` : `${downColor}66`
    })));
    chart.timeScale().fitContent();
    const resizeObserver = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [props.series]);

  return (
    <section className="market-chart-card">
      <header><div><strong>{props.series.ticker}</strong><span>{props.series.range} · {props.series.interval} · MOCK DATA</span></div><small>{props.series.exchange} · {props.series.currency}</small></header>
      <div className="market-chart" ref={containerRef} />
      <footer><span className="market-up">红色：上涨</span><span className="market-down">绿色：下跌</span><span>截至 {props.series.asOf}</span></footer>
    </section>
  );
}

/**
 * 从已脱敏工具结果中寻找行情时序，兼容本地 tool 与 MCP envelope。
 *
 * @param value 待检查的结构化值。
 * @param depth 当前递归深度。
 * @returns 找到的行情序列。
 */
export function findMarketSeries(value: unknown, depth = 0): MarketSeriesDto | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  if (isMarketSeries(value)) return value;
  for (const child of Object.values(value)) {
    const found = findMarketSeries(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** @param value 候选对象。 @returns 是否满足行情时序的最小结构。 */
function isMarketSeries(value: object): value is MarketSeriesDto {
  const candidate = value as Partial<MarketSeriesDto>;
  return typeof candidate.ticker === "string" && candidate.interval === "1d" && candidate.range === "3m" && Array.isArray(candidate.bars) && candidate.bars.length > 0;
}
