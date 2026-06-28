import type { FilingDocumentDto, FilingSourceDto } from "@aiagent/types";

export type FilingDocument = FilingDocumentDto;
export type FilingSource = FilingSourceDto;

export type FilingParseStatus = "pending" | "parsed" | "failed";

export interface FilingParseError {
  code: "unsupported_format" | "empty_source" | "parse_failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface FilingParseResult {
  ok: boolean;
  status: FilingParseStatus;
  document?: FilingDocument;
  error?: FilingParseError;
}

export interface FilingsPackageSummary {
  packageName: "@aiagent/filings";
  boundary: "filing_ingestion_and_raw_text";
  supportedSourceKinds: FilingSource["kind"][];
}

/**
 * 创建 filings package 的边界摘要，用于测试和 README 中说明 package 职责。
 *
 * @returns filings package 的稳定职责和当前支持的来源类型。
 */
export function createFilingsPackageSummary(): FilingsPackageSummary {
  return {
    packageName: "@aiagent/filings",
    boundary: "filing_ingestion_and_raw_text",
    supportedSourceKinds: ["local_file", "remote_url", "mock_text"]
  };
}

/**
 * 创建最小公告/财报文档对象，后续 ingestion 管线会替换 mock 文本来源。
 *
 * @param input 文档元数据、原始文本和来源信息。
 * @returns 可交给 RAG package 切分的标准 document。
 */
export function createFilingDocument(input: FilingDocument): FilingDocument {
  return {
    ...input,
    metadata: {
      ...input.metadata
    },
    source: {
      ...input.source
    }
  };
}
