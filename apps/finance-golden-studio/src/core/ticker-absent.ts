import type { ValidationIssue } from "./schema.js";
import { issue } from "./schema.js";

/** ticker_absent 的实际目标与来源形态。 */
export type TickerAbsentTarget =
  | { kind: "direct"; ticker: string }
  | { kind: "scoped"; ticker: string }
  | { kind: "conflict"; directTicker: string; scopedTicker: string }
  | { kind: "invalid" };

/**
 * 判定 ticker_absent 的权威目标。
 *
 * 非空 ticker 才构成直接形态；空字符串不能短路 scope。直接与 scoped 同时提供
 * 时，相同 ticker 可共存，不同 ticker 必须确定性冲突。直接形态保留当前类型契约，
 * 即只要求 ticker；scoped 形态要求合法 scope 与 expected_report="（无）"。
 *
 * @param resolution 待解析的 resolution 对象。
 * @returns 目标形态；没有足够有效信息时为 invalid。
 */
export function resolveTickerAbsentTarget(
  resolution: Record<string, unknown>
): TickerAbsentTarget {
  const directTicker = nonEmptyString(resolution.ticker);
  const scopedTicker = extractScopedTicker(resolution.scope);
  if (directTicker && scopedTicker && directTicker !== scopedTicker) {
    return { kind: "conflict", directTicker, scopedTicker };
  }
  if (directTicker) return { kind: "direct", ticker: directTicker };
  if (scopedTicker) return { kind: "scoped", ticker: scopedTicker };
  return { kind: "invalid" };
}

/**
 * 由实际目标生成“ticker 已在 manifest 收录”的错误。
 *
 * @param target ticker_absent 实际目标。
 * @returns 错误问题；目标无效时返回 undefined。
 */
export function tickerPresentIssue(
  target: TickerAbsentTarget
): ValidationIssue | undefined {
  if (target.kind === "invalid" || target.kind === "conflict") return undefined;
  return issue(
    "negative_ticker_present",
    `Negative resolution ticker ${target.ticker} exists in manifest.`,
    target.kind === "scoped" ? "resolution.scope" : "resolution.ticker"
  );
}

/**
 * 从 scope 提取 ticker。
 *
 * @param value scope 值。
 * @returns 合法 ticker；否则 undefined。
 */
function extractScopedTicker(value: unknown): string | undefined {
  return typeof value === "string"
    ? /^ticker=(\S+)$/u.exec(value.trim())?.[1]
    : undefined;
}

/**
 * 提取非空字符串。
 *
 * @param value 待判断值。
 * @returns trim 后非空时返回 trim 结果，否则 undefined。
 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
