import type { ISODateTimeString } from "./primitives.js";

/**
 * 公告/财报来源类型是 API 边界稳定枚举，避免 UI 和 ingestion package 重复声明。
 */
export type FilingSourceKindDto = "local_file" | "remote_url" | "mock_text";

/**
 * 文件来源 DTO 只保存跨边界需要展示和追踪的信息，不包含解析器内部状态。
 */
export interface FilingSourceDto {
  kind: FilingSourceKindDto;
  uri: string;
  provider?: string;
}

/**
 * 公告/财报类型用于后续筛选和检索，不绑定任何数据库模型。
 */
export type FilingReportTypeDto =
  | "annual_report"
  | "quarterly_report"
  | "interim_report"
  | "announcement"
  | "unknown";

/**
 * 公告/财报文档 DTO 表达 ingestion 输出的原始文本和元数据边界。
 */
export interface FilingDocumentDto {
  id: string;
  title: string;
  ticker?: string;
  reportType: FilingReportTypeDto;
  publishedAt?: ISODateTimeString;
  source: FilingSourceDto;
  metadata: Record<string, string | number | boolean | null>;
  rawText: string;
}

/**
 * Ingestion 支持的文件类型保持为小枚举，避免 API/UI 对扩展名做重复判断。
 */
export type FilingFileTypeDto = "pdf" | "markdown" | "txt";

/**
 * Ingestion 文本块 DTO 保存原文位置线索，是后续 chunk 和 citation 的证据来源。
 */
export interface IngestedTextBlockDto {
  id: string;
  text: string;
  heading?: string;
  lineStart: number;
  lineEnd: number;
  pageNumber?: number;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * Ingestion 输出 DTO 表达解析后的文档、文件来源和 block 级原文边界。
 */
export interface IngestedFilingDocumentDto {
  documentId: string;
  source: string;
  fileName: string;
  title: string;
  fileType: FilingFileTypeDto;
  createdAt: ISODateTimeString;
  metadata: Record<string, string | number | boolean | null>;
  blocks: IngestedTextBlockDto[];
}
