import type {
  DocumentFileTypeDto,
  DocumentSourceKindDto,
  IngestedDocumentDto,
  IngestedTextBlockDto
} from "@aiagent/types";

// 领域类型归属拥有包：parsing 复用 types 包里的线格式 DTO，但用语义更贴合的本地别名对外暴露。
export type DocumentFileType = DocumentFileTypeDto;
export type IngestedTextBlock = IngestedTextBlockDto;
export type IngestedDocument = IngestedDocumentDto;

/**
 * 解析阶段的 block 草稿：保留 heading / 页码 / 行号等原文位置线索，
 * 最终由 facade 补齐稳定 id 后组装为 DTO。
 *
 * 这是 citation 的稳定契约——OSS 解析器各自的 DTO 只通过 adapter 映射成这个形状，
 * 上层 chunk / citation 不直接依赖任何第三方解析器的输出类型。
 */
export interface ParsedBlock {
  text: string;
  heading?: string;
  lineStart: number;
  lineEnd: number;
  /** PDF 等带页码来源会保留页码，供后续 chunk / citation 标注原文位置。 */
  pageNumber?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

/** 解析并组装完成、可直接交给 chunking 的文档。 */
export type ParsedDocument = IngestedDocument;

/**
 * Ingestion 请求只依赖普通文本或字节数组，由 Web/API adapter 负责从 File 转换。
 */
export interface IngestDocumentRequest {
  source: string;
  fileName: string;
  contentType?: string;
  content: string | Uint8Array;
  metadata?: Record<string, unknown>;
}

/**
 * Ingestion 选项用于测试稳定性和切块策略调参，不把数据库或浏览器状态带入 package。
 */
export interface DocumentIngestionOptions {
  idGenerator?: (input: IngestDocumentRequest, fileType: DocumentFileType) => string;
  now?: () => Date;
  txtMaxLinesPerBlock?: number;
}

/**
 * 解析器入参：facade 归一化后交给具体 parser。
 *
 * content 保持 `string | Uint8Array` 联合，让文本 parser 与二进制 parser（PDF）
 * 都能从同一个入口取数，无需在 facade 里按格式分支。
 */
export interface ParserInput {
  readonly fileName: string;
  readonly contentType?: string;
  readonly content: string | Uint8Array;
  readonly options: DocumentIngestionOptions;
}

/**
 * 每格式一个解析 adapter，是 registry 的最小契约。
 *
 * - `contentTypes` / `extensions` 是检测的**单一事实来源**（registry 从同一份数据推导文件类型）；
 * - `accepts` 用于 magic bytes 等更强校验（如 PDF 的 `%PDF-`）；
 * - `parse` 失败时抛错，由 facade 收敛为结构化错误，不向调用方泄漏原始异常。
 */
export interface DocumentParser {
  readonly fileType: DocumentFileType;
  readonly contentTypes: readonly string[];
  readonly extensions: readonly string[];
  accepts?(input: ParserInput): boolean;
  parse(input: ParserInput): ParsedBlock[];
}

/**
 * Ingestion 错误码保持为稳定枚举，供调用方做程序化分支。
 *
 * 已删除死错误码 `pdf_parser_not_configured`：PDF 现在走真实解析，非法输入统一收敛为 `parse_failed`。
 */
export type DocumentIngestionErrorCode = "empty_file" | "unknown_file_type" | "parse_failed";

/**
 * Ingestion 错误保持为结构化返回值，避免 adapter 或 UI 捕获底层解析异常。
 */
export interface DocumentIngestionError {
  code: DocumentIngestionErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Ingestion 结果使用 discriminated union，让调用方先判断 ok 再读取 document 或 error。
 */
export type DocumentIngestionResult =
  | {
      ok: true;
      document: IngestedDocument;
    }
  | {
      ok: false;
      error: DocumentIngestionError;
    };

export interface ParsingPackageSummary {
  packageName: "@aiagent/parsing";
  boundary: "document_parsing_and_raw_text";
  supportedSourceKinds: DocumentSourceKindDto[];
  supportedFileTypes: DocumentFileType[];
}
