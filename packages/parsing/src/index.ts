// @aiagent/parsing 公共入口（barrel）。
//
// 定位：薄适配层——只维护"接口 + 映射 + registry"，不维护解析引擎。
// 架构：Facade（parse-document.ts）+ Registry（registry.ts）+ 每格式 Adapter（parsers/*.ts）
// + 共享段落骨架（block-collector.ts），照搬 MarkItDown 的 converter 范式。

// 领域 / DTO 类型
export type {
  DocumentFileType,
  DocumentIngestionError,
  DocumentIngestionErrorCode,
  DocumentIngestionOptions,
  DocumentIngestionResult,
  DocumentParser,
  IngestDocumentRequest,
  IngestedDocument,
  IngestedTextBlock,
  ParsedBlock,
  ParsedDocument,
  ParserInput,
  ParsingPackageSummary
} from "./types.js";

// 共享骨架：段落累积 / flush / 行号簿记 + 文本工具
export type { CollectedParagraph, ParagraphLineHandler } from "./block-collector.js";
export { collectParagraphBlocks, decodeContent, splitLines } from "./block-collector.js";

// registry：检测与解析共用同一份 parser 元数据（单一事实来源）
export { DEFAULT_PARSERS, ParserRegistry, defaultParserRegistry, detectDocumentFileType } from "./registry.js";

// Facade：ingestDocument（公共入口）→ parseDocument（detect → resolve → parse → assemble）
export { ingestDocument, parseDocument } from "./parse-document.js";

// 每格式 parser（adapter）
export { MarkdownParser, parseMarkdownBlocks } from "./parsers/markdown.js";
export { TxtParser, parseTxtBlocks } from "./parsers/txt.js";
export { PdfParser, buildPdfBlocks, countTableColumns, isTableRow, parsePdfBlocks } from "./parsers/pdf.js";

// 包边界摘要
export { createParsingPackageSummary } from "./package-summary.js";
