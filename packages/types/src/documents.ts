import type { ISODateTimeString } from "./primitives.js";

/**
 * 文档来源类型是 API 边界稳定枚举，避免 UI 和 ingestion package 重复声明。
 */
export type DocumentSourceKindDto = "local_file" | "remote_url" | "mock_text";

/**
 * 文档解析支持的文件类型保持为小枚举，避免 API/UI 对扩展名做重复判断。
 */
export type DocumentFileTypeDto = "pdf" | "markdown" | "txt";

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
export interface IngestedDocumentDto {
  documentId: string;
  source: string;
  fileName: string;
  title: string;
  fileType: DocumentFileTypeDto;
  createdAt: ISODateTimeString;
  metadata: Record<string, string | number | boolean | null>;
  blocks: IngestedTextBlockDto[];
}
