/** Golden Studio 草稿存储的稳定错误码。 */
export type GoldenStudioErrorCode =
  | "draft_not_found"
  | "draft_corrupt"
  | "atomic_write_failed"
  | "backup_failed"
  | "evidence_not_found"
  | "evidence_parse_failed";

/** Golden 草稿的题型枚举。 */
export type GoldenDraftType =
  | "numeric_fact"
  | "definitional"
  | "comparison"
  | "multi_doc"
  | "table"
  | "unit_trap"
  | "negative";

/** Golden 草稿的难度枚举。 */
export type GoldenDifficulty = "easy" | "medium" | "hard";

/** Golden 草稿答案的呈现类型枚举。 */
export type GoldenAnswerType = "number" | "list" | "table" | "form" | "text";

/** Golden 草稿引用报告的文档类型枚举。 */
export type GoldenReportType =
  | "annual"
  | "interim"
  | "q1"
  | "q2"
  | "q3"
  | "prospectus"
  | "announcement"
  | "esg";

/** Golden 草稿引用证据的介质类型。 */
export type GoldenSourceKind = "text" | "table" | "image";

/** 可追溯的表格型标准答案。 */
export interface GoldenAnswerTable {
  columns: string[];
  units?: Record<string, string>;
  rows: string[][];
}

/** 可追溯的键值表单型标准答案。 */
export interface GoldenAnswerForm {
  groups?: string[];
  items: Array<{ key: string; value: string }>;
}

/** 草稿引用的作者集来源证据。 */
export interface GoldenEvidence {
  ticker: string;
  report_type: GoldenReportType;
  period: string;
  section: string;
  page: number;
  quote: string;
  source_kind: GoldenSourceKind;
  ocr_required?: boolean;
  page_image_ref?: string;
}

/** 用于识别易混淆同源文档的引用。 */
export interface GoldenDocumentRef {
  ticker: string;
  report_type: GoldenReportType;
  period: string;
}

/** 时间路由题目的文档解析规则。 */
export interface GoldenLatestByResolution {
  type: "latest_by";
  field: string;
  scope: string;
  expected_report: string;
  span?: {
    window: string;
    rule: string;
  };
  coverage_note?: string;
}

/** 反例题目的语料缺席规则；现存 fin-012 只记录 scope 规则。 */
export interface GoldenScopedTickerAbsentResolution {
  type: "ticker_absent";
  scope: string;
  expected_report: string;
  note?: string;
  ticker?: never;
}

/** 反例题目的直接 ticker 规则，保留显式 ticker 记录形态。 */
export interface GoldenDirectTickerAbsentResolution {
  type: "ticker_absent";
  ticker: string;
  scope?: string;
  expected_report?: string;
  note?: string;
}

/** 草稿可携带的文档解析规则。 */
export type GoldenResolution =
  | GoldenLatestByResolution
  | GoldenScopedTickerAbsentResolution
  | GoldenDirectTickerAbsentResolution;

/** 草稿校验结果的轻量快照，由后续校验模块填充。 */
export interface DraftValidationSnapshot {
  ok: boolean;
  errors: Array<{ code: string; message: string; field?: string }>;
  warnings: Array<{ code: string; message: string; field?: string }>;
  keywordResults: Array<{
    keyword: string;
    reachable: boolean;
    evidenceIndexes: number[];
  }>;
}

/**
 * 草稿的本地工作流元信息。
 *
 * 该对象只存在于 `_drafts/`，发布作者集时必须由上层剔除。
 */
export interface GoldenDraftState {
  batch?: string;
  approved?: boolean;
  savedAt?: string;
  lastValidatedAt?: string;
  validation?: DraftValidationSnapshot;
  filePath?: string;
  [key: string]: unknown;
}

/** 可直接写入 `_drafts/<batch>/<id>.jsonl` 的完整作者草稿。 */
export interface GoldenDraft {
  id: string;
  query: string;
  type: GoldenDraftType;
  difficulty: GoldenDifficulty;
  answer_type: GoldenAnswerType;
  gold_answer: string;
  gold_answer_table?: GoldenAnswerTable;
  gold_answer_form?: GoldenAnswerForm;
  answer_unit: string;
  evidence: GoldenEvidence[];
  requires_multi_doc: boolean;
  distractors: GoldenDocumentRef[];
  is_negative: boolean;
  note: string;
  expected_keywords?: string[];
  resolution?: GoldenResolution;
  snapshot_dependent?: boolean;
  _draft: GoldenDraftState;
}

/** 写入 `golden.jsonl` 的作者集条目，不包含草稿本地元信息。 */
export type GoldenCase = Omit<GoldenDraft, "_draft">;

/** 批次列表使用的聚合摘要。 */
export interface BatchSummary {
  name: string;
  draftCount: number;
  approvedCount: number;
  pendingCount: number;
  corruptCount: number;
}

/** 草稿列表使用的轻量摘要；损坏文件也会保留在列表中。 */
export interface DraftSummary {
  id: string;
  query: string;
  type: string;
  approved: boolean;
  isNegative: boolean;
  health?: string;
  corrupt: boolean;
  errorCode?: GoldenStudioErrorCode;
}

/** 原子保存草稿后返回的规范化结果。 */
export interface SaveDraftResult {
  draft: GoldenDraft;
  filePath: string;
}
