import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePdfBlocks } from "@aiagent/parsing";
import { saveDraft } from "./drafts.js";
import { GoldenStudioError } from "./errors.js";
import type { ManifestRecord } from "./manifest.js";
import { manifestTripleKey, readManifest } from "./manifest.js";
import type {
  GoldenAnswerType,
  GoldenDraft,
  GoldenDraftType
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import {
  assertContainedPath,
  validateBatchName,
  WorkspaceError
} from "./workspace.js";

/** 半自动候选输入的一行。 */
export interface MineCandidate {
  ticker: string;
  report_type: string;
  period: string;
  type: GoldenDraftType;
  periods?: string[];
}

/** mine 的批次与候选输入。 */
export interface MineInput {
  batch: string;
  candidates: readonly MineCandidate[];
}

/** 未能生成草稿的候选及稳定原因。 */
export interface MineSkip {
  candidate: MineCandidate;
  id: string;
  reason:
    | "evidence_not_in_manifest"
    | "evidence_not_found"
    | "evidence_parse_failed"
    | "extraction_too_short"
    | "invalid_candidate";
  message: string;
}

/** mine 工作流结果。 */
export interface MineReport {
  ok: boolean;
  complete: boolean;
  batch: string;
  draftedCount: number;
  skippedCount: number;
  drafts: GoldenDraft[];
  skipped: MineSkip[];
}

/** 题型对应的章节锚点；未登记题型回退到财务指标锚点。 */
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
 * 从精确定位的 PDF 生成待人工补全的候选草稿。
 *
 * 候选条目通过现有草稿仓库原子保存。来源三元组缺失、PDF 缺失或抽取文本
 * 过短都作为显式跳过项返回，不借用同 ticker 的其他文件。
 *
 * @param config 当前工作区配置。
 * @param input 批次名与候选列表。
 * @returns 已写草稿与跳过诊断。
 */
export async function mineCandidates(
  config: WorkspaceConfig,
  input: MineInput
): Promise<MineReport> {
  validateBatchName(input.batch);
  assertContainedPath(config.workspaceRoot, config.draftRoot);
  const manifest = await readManifest(config);
  if (manifest.errors.length > 0) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      "Corpus manifest is invalid; mining cannot resolve exact sources.",
      { errors: manifest.errors, manifestPath: config.manifestPath }
    );
  }
  const byTriple = new Map(
    manifest.records.map((record) => [manifestTripleKey(record), record])
  );
  const tickers = new Set(manifest.records.map((record) => record.ticker));
  const drafts: GoldenDraft[] = [];
  const skipped: MineSkip[] = [];

  for (const [index, candidate] of input.candidates.entries()) {
    const id = `fin-D${String(index + 1).padStart(3, "0")}`;
    const invalid = validateCandidate(candidate);
    if (invalid) {
      skipped.push({ candidate, id, reason: "invalid_candidate", message: invalid });
      continue;
    }

    if (candidate.type === "negative") {
      if (tickers.has(candidate.ticker)) {
        skipped.push({
          candidate,
          id,
          reason: "invalid_candidate",
          message: `Negative candidate ${candidate.ticker} already exists in the corpus manifest.`
        });
        continue;
      }
      const saved = await saveDraft(
        config,
        input.batch,
        id,
        buildNegativeDraft(candidate, id)
      );
      drafts.push(saved.draft);
      continue;
    }

    const record = byTriple.get(manifestTripleKey(candidate));
    if (!record) {
      skipped.push({
        candidate,
        id,
        reason: "evidence_not_in_manifest",
        message: `Exact manifest triple not found: ${manifestTripleKey(candidate)}.`
      });
      continue;
    }

    try {
      const result = await buildCandidateDraft(config, candidate, record, id);
      if ("reason" in result) {
        skipped.push({ candidate, id, ...result });
        continue;
      }
      const saved = await saveDraft(config, input.batch, id, result);
      drafts.push(saved.draft);
    } catch (error) {
      const mapped = mapEvidenceError(error, candidate, id);
      skipped.push(mapped);
    }
  }

  return {
    ok: skipped.length === 0,
    complete: drafts.length > 0 && skipped.length === 0,
    batch: input.batch,
    draftedCount: drafts.length,
    skippedCount: skipped.length,
    drafts,
    skipped
  };
}

/**
 * 从已解析块构建候选草稿。
 *
 * @param candidate 候选定义。
 * @param record 精确 manifest 记录。
 * @param id 草稿 ID。
 * @param blocks 已解析 PDF 块。
 * @returns 可原子保存的候选草稿。
 * @throws {Error} 抽取文本不足以形成候选时抛出。
 */
function buildMineDraft(
  candidate: MineCandidate,
  record: ManifestRecord,
  id: string,
  blocks: ReturnType<typeof parsePdfBlocks>
): GoldenDraft {
  const text = blocks.map((block) => block.text).join("\n");
  if (text.replace(/\s+/gu, "").length < 200) {
    throw new Error("Candidate PDF has too little extractable text.");
  }
  const anchor = locateAnchor(blocks, TYPE_ANCHORS[candidate.type]);
  const extraEvidence = (candidate.periods ?? [])
    .filter((period) => period !== candidate.period)
    .map((period) => ({
      ticker: candidate.ticker,
      report_type: candidate.report_type as GoldenDraft["evidence"][number]["report_type"],
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
 * 构建非负例候选草稿。
 *
 * @param config 当前工作区配置。
 * @param candidate 候选定义。
 * @param record 精确 manifest 记录。
 * @param id 草稿 ID。
 * @returns 草稿或抽取跳过原因。
 */
async function buildCandidateDraft(
  config: WorkspaceConfig,
  candidate: MineCandidate,
  record: ManifestRecord,
  id: string
): Promise<GoldenDraft | Omit<MineSkip, "candidate" | "id">> {
  const absolutePath = join(config.corpusRoot, record.file_path);
  assertContainedPath(config.corpusRoot, absolutePath);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw new GoldenStudioError(
      "evidence_not_found",
      `Candidate PDF cannot be read: ${record.file_path}.`,
      { filePath: record.file_path },
      error
    );
  }

  let blocks: ReturnType<typeof parsePdfBlocks>;
  try {
    blocks = parsePdfBlocks(bytes);
  } catch (error) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `Candidate PDF cannot be parsed: ${record.file_path}.`,
      { filePath: record.file_path },
      error
    );
  }
  const text = blocks.map((block) => block.text).join("\n");
  if (text.replace(/\s+/gu, "").length < 200) {
    return {
      reason: "extraction_too_short",
      message: `Candidate PDF has too little extractable text: ${record.file_path}.`
    };
  }
  return buildMineDraft(candidate, record, id, blocks);
}

/**
 * 在解析块中查找首个题型锚点，并返回原文窗口与页码。
 *
 * @param blocks 已解析 PDF 块。
 * @param anchors 候选章节锚点。
 * @returns 命中锚点及其窗口；无命中时为 undefined。
 */
function locateAnchor(
  blocks: ReturnType<typeof parsePdfBlocks>,
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
 * 为 negative 候选创建显式缺席规则。
 *
 * @param candidate negative 候选。
 * @param id 草稿 ID。
 * @returns 待人工补问句与答案的反例草稿。
 */
function buildNegativeDraft(candidate: MineCandidate, id: string): GoldenDraft {
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
function validateCandidate(candidate: MineCandidate): string | undefined {
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
 * 将 evidence I/O 异常转换为候选跳过项。
 *
 * @param error 捕获异常。
 * @param candidate 当前候选。
 * @param id 候选 ID。
 * @returns 稳定的跳过诊断。
 */
function mapEvidenceError(
  error: unknown,
  candidate: MineCandidate,
  id: string
): MineSkip {
  if (
    error instanceof GoldenStudioError &&
    (error.code === "evidence_not_found" || error.code === "evidence_parse_failed")
  ) {
    return {
      candidate,
      id,
      reason: error.code,
      message: error.message
    };
  }
  if (error instanceof WorkspaceError) throw error;
  throw error;
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
