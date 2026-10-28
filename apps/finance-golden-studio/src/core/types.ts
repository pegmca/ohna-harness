/** Golden Studio 草稿存储的稳定错误码。 */
export type GoldenStudioErrorCode =
  | "draft_not_found"
  | "draft_corrupt"
  | "drafts_not_found"
  | "atomic_write_failed"
  | "backup_failed"
  | "evidence_not_found"
  | "evidence_parse_failed";

/** Golden 校验问题的稳定代码。 */
export type ValidationIssueCode =
  | GoldenStudioErrorCode
  | "workspace_config_missing"
  | "invalid_root_path"
  | "manifest_not_found"
  | "path_outside_root"
  | "invalid_batch_name"
  | "invalid_draft_id"
  | "golden_file_not_found"
  | "golden_json_invalid"
  | "golden_line_not_object"
  | "golden_line_count_invalid"
  | "golden_id_duplicate"
  | "manifest_json_invalid"
  | "manifest_record_invalid"
  | "manifest_triple_duplicate"
  | "expected_keywords_required"
  | "expected_keyword_empty"
  | "keyword_unreachable"
  | "section_unresolved"
  | "evidence_required"
  | "evidence_not_in_manifest"
  | "negative_evidence_present"
  | "negative_resolution_required"
  | "negative_ticker_present"
  | "negative_ticker_conflict"
  | "negative_scope_invalid"
  | "negative_type_required"
  | "multi_doc_flag_required"
  | "multi_doc_sources_required"
  | "table_columns_required"
  | "table_rows_required"
  | "table_row_not_array"
  | "table_sparse_row"
  | "table_cell_not_string"
  | "form_items_required"
  | "form_item_invalid"
  | "required_string_invalid"
  | "array_required"
  | "boolean_required"
  | "enum_invalid"
  | "id_invalid"
  | "evidence_invalid"
  | "distractor_invalid"
  | "answer_structure_required"
  | "resolution_required"
  | "resolution_invalid";

/** 单条校验问题；field 指向作者可定位的 JSON 路径。 */
export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  field?: string;
  line?: number;
  id?: string;
}

/** 单个关键词在扫描文本中的可达性摘要。 */
export interface KeywordReachabilityResult {
  keyword: string;
  normalizedKeyword: string;
  reachable: boolean;
  reason?: "empty" | "unreachable";
  evidenceIndexes: number[];
}

/** CLI、HTTP、UI、promote 与 generate 共用的校验结果。 */
export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  keywordResults: KeywordReachabilityResult[];
}

/** 单批次校验结果，供 CLI 与本地 server 共享。 */
export interface DraftBatchValidationResult {
  batch: string;
  draftCount: number;
  validation: ValidationReport;
}

/** 当前草稿范围的校验结果。 */
export interface DraftScopedValidationResult {
  batch: string;
  id: string;
  validation: ValidationReport;
}

/** 从解析 block 投影的证据元数据。 */
export type PdfEvidenceMetadata = Record<
  string,
  string | number | boolean | null
>;

/** 可交给 Web 与 CLI 共用的 PDF 证据块。 */
export interface PdfEvidenceBlock {
  pageNumber: number;
  lineStart: number;
  lineEnd: number;
  text: string;
  metadata: PdfEvidenceMetadata;
}

/** 一份来源 PDF 的页面列表与按原文顺序排列的证据块。 */
export interface PdfEvidenceDocument {
  filePath: string;
  pages: number[];
  blocks: PdfEvidenceBlock[];
}

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
  errors: Array<{ code: ValidationIssueCode; message: string; field?: string }>;
  warnings: Array<{ code: ValidationIssueCode; message: string; field?: string }>;
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

/** 本地发布账本中一条已成功落地的草稿到作者集映射。 */
export interface GoldenPublicationRecord {
  batch: string;
  draftId: string;
  goldenId: string;
  contentHash: string;
  publishedAt: string;
}

/** 工作区内部发布账本；用于 promote 重试去重与追溯。 */
export interface GoldenPublicationLedger {
  version: 1;
  publications: GoldenPublicationRecord[];
}

/** 已完成 golden 写入、但尚需与发布账本互换的短暂记录。 */
export interface PendingGoldenPublication {
  version: 1;
  publications: GoldenPublicationRecord[];
}
