import type { GoldenResolution } from "../src/core/types.ts";

/** 现存 latest_by 记录可携带跨年窗口与覆盖说明。 */
const latestBy: GoldenResolution = {
  type: "latest_by",
  field: "disclosure_date",
  scope: "ticker=603501.SH",
  expected_report: "annual/2025",
  span: {
    window: "near_years",
    rule: "从最新年报往前查，叠加各年报自带的往年同期数"
  },
  coverage_note: "语料仅有 2024、2025 两份年报，覆盖 2022–2025"
};

/** fin-012 的现存 ticker_absent 记录只带规则说明，不带顶层 ticker。 */
const tickerAbsent: GoldenResolution = {
  type: "ticker_absent",
  scope: "ticker=002340.SZ",
  expected_report: "（无）",
  note: "语料 manifest.jsonl 中无 002340.SZ 任何记录，故无源文档可检索"
};

void [latestBy, tickerAbsent];
