import type {
  FilingDocumentDto,
  FilingFileTypeDto,
  FilingSourceDto,
  IngestedFilingDocumentDto,
  IngestedTextBlockDto
} from "@aiagent/types";
// ingestFiling 内部同步调用 parsePdfBlocks，parseMarkdownBlocks/parseTxtBlocks 调用 splitLines，
// 均需从 pdf.ts 引入本地绑定（re-export 不提供模块内绑定）。
import { parsePdfBlocks, splitLines } from "./pdf.js";
// FilingParsedBlock 仅在函数签名中作为类型引用，用 import type 单向引入（编译期擦除，无运行时依赖）。
import type { FilingParsedBlock } from "./pdf.js";

export type FilingDocument = FilingDocumentDto;
export type FilingSource = FilingSourceDto;
export type FilingFileType = FilingFileTypeDto;
export type IngestedTextBlock = IngestedTextBlockDto;
export type IngestedFilingDocument = IngestedFilingDocumentDto;

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

export type FilingIngestionErrorCode =
  | "empty_file"
  | "unknown_file_type"
  | "pdf_parser_not_configured"
  | "parse_failed";

/**
 * Ingestion 错误保持为结构化返回值，避免 adapter 或 UI 捕获底层解析异常。
 */
export interface FilingIngestionError {
  code: FilingIngestionErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Ingestion 请求只依赖普通文本或字节数组，由 Web/API adapter 负责从 File 转换。
 */
export interface IngestFilingRequest {
  source: string;
  fileName: string;
  contentType?: string;
  content: string | Uint8Array;
  metadata?: Record<string, unknown>;
}

/**
 * Ingestion 选项用于测试稳定性和切块策略调参，不把数据库或浏览器状态带入 package。
 */
export interface FilingIngestionOptions {
  idGenerator?: (input: IngestFilingRequest, fileType: FilingFileType) => string;
  now?: () => Date;
  txtMaxLinesPerBlock?: number;
}

/**
 * Ingestion 结果使用 discriminated union，让调用方先判断 ok 再读取 document 或 error。
 */
export type FilingIngestionResult =
  | {
      ok: true;
      document: IngestedFilingDocument;
    }
  | {
      ok: false;
      error: FilingIngestionError;
    };

export interface FilingsPackageSummary {
  packageName: "@aiagent/filings";
  boundary: "filing_ingestion_and_raw_text";
  supportedSourceKinds: FilingSource["kind"][];
  supportedFileTypes: FilingFileType[];
}

/**
 * 创建 filings package 的边界摘要，用于测试和 README 中说明 package 职责。
 *
 * @returns filings package 的稳定职责、来源类型和当前可识别文件类型。
 */
export function createFilingsPackageSummary(): FilingsPackageSummary {
  return {
    packageName: "@aiagent/filings",
    boundary: "filing_ingestion_and_raw_text",
    supportedSourceKinds: ["local_file", "remote_url", "mock_text"],
    supportedFileTypes: ["markdown", "txt", "pdf"]
  };
}

/**
 * 创建最小公告/财报文档对象，兼容 Week 2 package foundation 中的 rawText 文档边界。
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

/**
 * 将上传或 adapter 传入的公告/财报内容解析为带 block 来源位置的结构化文档。
 *
 * @param request 文件来源、文件名、content-type、内容和调用方 metadata。
 * @param options 测试或运行时可注入的 id、时间和 TXT 切块参数。
 * @returns 成功时返回 document，失败时返回结构化 ingestion error。
 */
export function ingestFiling(
  request: IngestFilingRequest,
  options: FilingIngestionOptions = {}
): FilingIngestionResult {
  const fileType = detectFilingFileType(request.fileName, request.contentType);

  if (!fileType) {
    return ingestionFailure("unknown_file_type", "无法识别公告/财报文件类型。", {
      fileName: request.fileName,
      contentType: request.contentType ?? null
    });
  }

  const text = decodeContent(request.content);

  if (text.trim().length === 0) {
    return ingestionFailure("empty_file", "公告/财报文件内容为空。", {
      fileName: request.fileName,
      fileType
    });
  }

  if (fileType === "pdf") {
    // PDF 内容必须是二进制字节；字符串形式无法解析，直接返回结构化错误而非抛异常。
    if (typeof request.content === "string") {
      return ingestionFailure("parse_failed", "PDF 内容应为二进制字节（Uint8Array），不支持字符串入参。", {
        fileName: request.fileName,
        contentType: request.contentType ?? null
      });
    }

    try {
      const parsedBlocks = parsePdfBlocks(request.content);

      if (parsedBlocks.length === 0) {
        return ingestionFailure("empty_file", "PDF 未解析出有效文本块。", {
          fileName: request.fileName,
          fileType
        });
      }

      const documentId = options.idGenerator?.(request, fileType) ?? createStableDocumentId(request, fileType);
      const metadata = normalizeMetadata(request.metadata);
      const title = resolveTitle(request.fileName, fileType, parsedBlocks.map((block) => block.text).join("\n"), metadata);
      const createdAt = (options.now?.() ?? new Date()).toISOString();

      return {
        ok: true,
        document: {
          documentId,
          source: request.source,
          fileName: request.fileName,
          title,
          fileType,
          createdAt,
          metadata,
          blocks: parsedBlocks.map((block, index) => createTextBlock(documentId, index, block))
        }
      };
    } catch (error) {
      return ingestionFailure("parse_failed", "PDF 解析失败。", {
        fileName: request.fileName,
        fileType,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    const txtMaxLinesPerBlock = Math.max(1, Math.floor(options.txtMaxLinesPerBlock ?? 12));
    const parsedBlocks =
      fileType === "markdown"
        ? parseMarkdownBlocks(text)
        : parseTxtBlocks(text, txtMaxLinesPerBlock);

    if (parsedBlocks.length === 0) {
      return ingestionFailure("empty_file", "公告/财报文件未解析出有效文本块。", {
        fileName: request.fileName,
        fileType
      });
    }

    const documentId = options.idGenerator?.(request, fileType) ?? createStableDocumentId(request, fileType);
    const metadata = normalizeMetadata(request.metadata);
    const title = resolveTitle(request.fileName, fileType, text, metadata);
    const createdAt = (options.now?.() ?? new Date()).toISOString();

    return {
      ok: true,
      document: {
        documentId,
        source: request.source,
        fileName: request.fileName,
        title,
        fileType,
        createdAt,
        metadata,
        blocks: parsedBlocks.map((block, index) => createTextBlock(documentId, index, block))
      }
    };
  } catch (error) {
    return ingestionFailure("parse_failed", "公告/财报文件解析失败。", {
      fileName: request.fileName,
      fileType,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * 根据文件扩展名和 content-type 判断 ingestion 文件类型。
 *
 * @param fileName adapter 传入的原始文件名。
 * @param contentType 可选 MIME 类型。
 * @returns 可解析文件类型；未知类型返回 undefined。
 */
export function detectFilingFileType(fileName: string, contentType?: string): FilingFileType | undefined {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();

  if (normalizedContentType) {
    if (["text/markdown", "text/x-markdown"].includes(normalizedContentType)) {
      return "markdown";
    }

    if (normalizedContentType === "text/plain") {
      return "txt";
    }

    if (normalizedContentType === "application/pdf") {
      return "pdf";
    }
  }

  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  if (extension === "md" || extension === "markdown") {
    return "markdown";
  }

  if (extension === "txt" || extension === "text") {
    return "txt";
  }

  if (extension === "pdf") {
    return "pdf";
  }

  return undefined;
}

/**
 * 解析 Markdown 文本块，保留最近 heading 和 1-based 行号，供后续 chunk 引用原文位置。
 *
 * @param content Markdown 原始文本。
 * @returns 带 heading 线索的文本块草稿。
 */
export function parseMarkdownBlocks(content: string): FilingParsedBlock[] {
  const lines = splitLines(content);
  const blocks: FilingParsedBlock[] = [];
  let currentHeading: string | undefined;
  let paragraphLines: string[] = [];
  let paragraphStart = 0;

  const flushParagraph = (lineEnd: number): void => {
    const text = paragraphLines.join("\n").trim();

    if (text.length > 0) {
      blocks.push({
        text,
        heading: currentHeading,
        lineStart: paragraphStart,
        lineEnd
      });
    }

    paragraphLines = [];
    paragraphStart = 0;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);

    if (headingMatch) {
      flushParagraph(lineNumber - 1);
      currentHeading = headingMatch[2]?.trim();
      blocks.push({
        text: currentHeading ?? "",
        heading: currentHeading,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        metadata: {
          blockRole: "heading",
          headingLevel: headingMatch[1]?.length ?? 1
        }
      });
      return;
    }

    if (line.trim().length === 0) {
      flushParagraph(lineNumber - 1);
      return;
    }

    if (paragraphLines.length === 0) {
      paragraphStart = lineNumber;
    }

    paragraphLines.push(line);
  });

  flushParagraph(lines.length);

  return blocks.filter((block) => block.text.trim().length > 0);
}

/**
 * 解析 TXT 文本块，优先按空行切分，连续长段落按固定行数拆分以控制后续 chunk 输入规模。
 *
 * @param content TXT 原始文本。
 * @param maxLinesPerBlock 没有空行时每个 block 的最大行数。
 * @returns 带 1-based 行号的文本块草稿。
 */
export function parseTxtBlocks(content: string, maxLinesPerBlock = 12): FilingParsedBlock[] {
  const lines = splitLines(content);
  const safeMaxLinesPerBlock = Math.max(1, Math.floor(maxLinesPerBlock));
  const blocks: FilingParsedBlock[] = [];
  let paragraphLines: string[] = [];
  let paragraphStart = 0;

  const flushParagraph = (lineEnd: number): void => {
    if (paragraphLines.length === 0) {
      return;
    }

    for (let start = 0; start < paragraphLines.length; start += safeMaxLinesPerBlock) {
      const chunkLines = paragraphLines.slice(start, start + safeMaxLinesPerBlock);
      const blockLineStart = paragraphStart + start;
      const blockLineEnd = blockLineStart + chunkLines.length - 1;
      const text = chunkLines.join("\n").trim();

      if (text.length > 0) {
        blocks.push({
          text,
          lineStart: blockLineStart,
          lineEnd: Math.min(blockLineEnd, lineEnd)
        });
      }
    }

    paragraphLines = [];
    paragraphStart = 0;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.trim().length === 0) {
      flushParagraph(lineNumber - 1);
      return;
    }

    if (paragraphLines.length === 0) {
      paragraphStart = lineNumber;
    }

    paragraphLines.push(line);
  });

  flushParagraph(lines.length);

  return blocks;
}

// PDF 解析相关实现已抽到 ./pdf.ts，这里原样再导出以保持公共 API 不变。
export { parsePdfBlocks, buildPdfBlocks, isTableRow, countTableColumns, splitLines } from "./pdf.js";
export type { FilingParsedBlock } from "./pdf.js";

/**
 * 将 string 或 Uint8Array 统一解码为文本，避免 package 直接依赖浏览器 File API。
 *
 * @param content adapter 传入的文件内容。
 * @returns UTF-8 文本。
 */
function decodeContent(content: string | Uint8Array): string {
  if (typeof content === "string") {
    return content.replace(/^\uFEFF/, "");
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(content).replace(/^\uFEFF/, "");
}

/**
 * 生成稳定 document id，让无数据库场景下的测试和 demo 结果可预测。
 *
 * @param request ingestion 请求。
 * @param fileType 已识别的文件类型。
 * @returns 基于 source、fileName、fileType 和内容的稳定 id。
 */
function createStableDocumentId(request: IngestFilingRequest, fileType: FilingFileType): string {
  const basis = `${request.source}|${request.fileName}|${fileType}|${decodeContent(request.content)}`;

  return `filing_${hashString(basis)}`;
}

/**
 * 从 metadata、Markdown H1 或文件名推导展示标题。
 *
 * @param fileName 原始文件名。
 * @param fileType 已识别的文件类型。
 * @param content 原始文本。
 * @param metadata 归一化后的 metadata。
 * @returns 可展示且可检索的文档标题。
 */
function resolveTitle(
  fileName: string,
  fileType: FilingFileType,
  content: string,
  metadata: Record<string, string | number | boolean | null>
): string {
  const metadataTitle = metadata.title;

  if (typeof metadataTitle === "string" && metadataTitle.trim().length > 0) {
    return metadataTitle.trim();
  }

  if (fileType === "markdown") {
    const heading = splitLines(content)
      .map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
      .find((value): value is string => Boolean(value));

    if (heading) {
      return heading;
    }
  }

  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

/**
 * 将调用方 metadata 收敛为可跨 API 序列化的简单值，复杂对象保留为 JSON 字符串。
 *
 * @param metadata 调用方传入的任意 metadata。
 * @returns 适合进入 DTO 的 metadata。
 */
function normalizeMetadata(metadata: Record<string, unknown> = {}): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        return [key, value as string | number | boolean | null];
      }

      return [key, JSON.stringify(value)];
    })
  );
}

/**
 * 为 block 补齐稳定 id 和默认 metadata，形成可直接交给 chunking 的文本块 DTO。
 *
 * @param documentId 文档稳定 id。
 * @param index 文档内 block 顺序。
 * @param block 解析阶段产生的文本块草稿。
 * @returns 完整 ingestion text block。
 */
function createTextBlock(documentId: string, index: number, block: FilingParsedBlock): IngestedTextBlock {
  return {
    id: `${documentId}_block_${String(index + 1).padStart(4, "0")}`,
    text: block.text,
    heading: block.heading,
    lineStart: block.lineStart,
    lineEnd: block.lineEnd,
    pageNumber: block.pageNumber,
    metadata: block.metadata ?? {}
  };
}

/**
 * 构造统一 ingestion 失败结果，确保调用方不需要捕获原始异常。
 *
 * @param code 稳定错误码。
 * @param message 面向调用方的错误说明。
 * @param details 可审查的错误上下文。
 * @returns 结构化失败结果。
 */
function ingestionFailure(
  code: FilingIngestionErrorCode,
  message: string,
  details: Record<string, unknown>
): FilingIngestionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details
    }
  };
}

/**
 * 使用 FNV-1a 生成短 hash，足够支撑 demo ingestion 的稳定 id，不承担安全用途。
 *
 * @param value 需要生成 hash 的字符串。
 * @returns 8 位十六进制 hash。
 */
function hashString(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
