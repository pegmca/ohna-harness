import type { ParsedBlock } from "@aiagent/parsing";
import type { ManifestRecord } from "./manifest.js";
import type {
  GoldenAnswerType,
  GoldenDraft,
  GoldenDraftType
} from "./types.js";

/** 半自动候选输入的一行。 */
export interface MineCandidate {
  ticker: string;
  report_type: string;
  period: string;
  type: GoldenDraftType;
  periods?: string[];
}

/** 题型对应的章节锚点。 */
const TYPE_ANCHORS: Record<GoldenDraftType, readonly string[]> = {
  numeric_fact: ["主要会计数据", "主要会计数据和财务指标", "会计数据"],
  definitional: ["公司从事的主要业务", "主营业务", "经营范围"],
  comparison: ["主要会计数据", "主要会计数据和财务指标"],
  multi_doc: ["主要会计数据", "主要会计数据和财务指标"],
  table: ["主要控股", "主要参股", "长期应收款", "坏账准备", "应收账款", "前五名"],
  unit_trap: ["主要会计数据", "主要会计数据和财务指标"],
  negative: []
};

/**
 * 从已解析块构建非负例候选草稿。
 *
 * @param candidate 候选定义。
 * @param record 精确 manifest 记录。
 * @param id 草稿 ID。
 * @param blocks 已解析 PDF 块。
 * @returns 可原子保存的候选草稿。
 */
export function buildMineDraft(
  candidate: MineCandidate,
  record: ManifestRecord,
  id: string,
  blocks: readonly ParsedBlock[]
): GoldenDraft {
  const anchor = locateAnchor(blocks, TYPE_ANCHORS[candidate.type]);
  const extraEvidence = (candidate.periods ?? [])
    .filter((period) => period !== candidate.period)
    .map((period) => ({
      ticker: candidate.ticker,
      report_type:
        candidate.report_type as GoldenDraft["evidence"][number]["report_type"],
      period,
      section: "（待补：跨报告期）",
      page: 0,
      quote: "",
      source_kind: "text" as const
    }));

  return {
    id,
    query: `（待填：${candidate.ticker} ${candidate.period} ${candidate.type}）`,
    type: candidate.type,
    difficulty: "medium",
    answer_type: defaultAnswerType(candidate.type),
    gold_answer: "",
    answer_unit: "（待补）",
    evidence: [
      {
        ticker: candidate.ticker,
        report_type:
          candidate.report_type as GoldenDraft["evidence"][number]["report_type"],
        period: candidate.period,
        section: anchor ? `（候选：${anchor.anchor}）` : "（待补：章节）",
        page: anchor?.page ?? 0,
        quote: anchor?.window ?? "",
        source_kind: "text"
      },
      ...extraEvidence
    ],
    expected_keywords: [],
    requires_multi_doc:
      candidate.type === "multi_doc" || extraEvidence.length > 0,
    distractors: [],
    is_negative: false,
    note: anchor
      ? `候选锚点=${anchor.anchor}@p${anchor.page}；人工补真值/拆分`
      : "未命中锚点，人工定位",
    _draft: {
      ticker: candidate.ticker,
      type: candidate.type,
      file_path: record.file_path,
      extraction_health: "ok",
      candidate_window: anchor?.window ?? ""
    }
  };
}

/**
 * 为 negative 候选创建显式缺席规则。
 *
 * @param candidate negative 候选。
 * @param id 草稿 ID。
 * @returns 待人工补问句与答案的反例草稿。
 */
export function buildNegativeDraft(
  candidate: MineCandidate,
  id: string
): GoldenDraft {
  return {
    id,
    query: `（待填：${candidate.ticker} ${candidate.period} 反例）`,
    type: "negative",
    difficulty: "easy",
    answer_type: "text",
    gold_answer: "（待填：语料中无该 ticker 的财报）",
    answer_unit: "文本",
    evidence: [],
    requires_multi_doc: false,
    distractors: [],
    is_negative: true,
    note: "negative 反例：语料无此 ticker，应拒答/不应编造",
    resolution: {
      type: "ticker_absent",
      scope: `ticker=${candidate.ticker}`,
      expected_report: "（无）",
      note: "语料 manifest 中无该 ticker 的任何记录"
    },
    _draft: {
      ticker: candidate.ticker,
      type: "negative",
      extraction_health: "n/a"
    }
  };
}

/**
 * 校验候选必需字段与题型。
 *
 * @param candidate 待校验候选。
 * @returns 错误说明；合法时为 undefined。
 */
export function validateMineCandidate(
  candidate: MineCandidate
): string | undefined {
  if (
    !candidate.ticker?.trim() ||
    !candidate.report_type?.trim() ||
    !candidate.period?.trim()
  ) {
    return "Candidate requires ticker, report_type and period.";
  }
  if (!Object.hasOwn(TYPE_ANCHORS, candidate.type)) {
    return `Unsupported candidate type: ${String(candidate.type)}.`;
  }
  return undefined;
}

/**
 * 在解析块中查找首个题型锚点，并返回原文窗口与页码。
 *
 * @param blocks 已解析 PDF 块。
 * @param anchors 候选章节锚点。
 * @returns 命中锚点及其窗口；无命中时为 undefined。
 */
function locateAnchor(
  blocks: readonly ParsedBlock[],
  anchors: readonly string[]
): { anchor: string; page: number; window: string } | undefined {
  const normalizedBlocks = blocks.map((block) => ({
    ...block,
    normalized: normalizeCjk(block.text)
  }));
  const full = normalizedBlocks.map((block) => block.normalized).join("\n");
  for (const anchor of anchors) {
    const index = full.indexOf(anchor);
    if (index === -1) continue;
    let offset = 0;
    let page = normalizedBlocks[0]?.pageNumber ?? 0;
    for (const block of normalizedBlocks) {
      const next = offset + block.normalized.length + 1;
      if (index < next) {
        page = block.pageNumber ?? 0;
        break;
      }
      offset = next;
    }
    return {
      anchor,
      page,
      window: full.slice(index, index + 600).replace(/\n/gu, " ")
    };
  }
  return undefined;
}

/**
 * 归一 CJK 字符间空格，保留数字和英文原有空格。
 *
 * @param text PDF 文本。
 * @returns 便于锚点搜索的文本。
 */
function normalizeCjk(text: string): string {
  return text.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/gu, "$1$2");
}

/**
 * 根据题型选择默认答案展示类型。
 *
 * @param type 题型。
 * @returns 初始答案类型。
 */
function defaultAnswerType(type: GoldenDraftType): GoldenAnswerType {
  if (type === "table") return "table";
  if (type === "definitional") return "text";
  return "number";
}
