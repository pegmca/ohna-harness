import type {
  DocumentFileType,
  DocumentIngestionError,
  DocumentIngestionErrorCode,
  DocumentIngestionOptions,
  DocumentIngestionResult,
  IngestDocumentRequest,
  IngestedTextBlock,
  ParsedBlock,
  ParsedDocument,
  ParserInput
} from "./types.js";
import { decodeContent, splitLines } from "./block-collector.js";
import { defaultParserRegistry, detectDocumentFileType } from "./registry.js";

/**
 * 将上传或 adapter 传入的文档内容解析为带 block 来源位置的结构化文档。
 *
 * 这是包的公共 ingestion 入口（对外名保持 `ingestDocument`），内部委托 facade `parseDocument`，
 * 让"入口名"与"主流程实现"解耦，后续新增格式只注册 parser，不改本函数。
 *
 * @param request 文件来源、文件名、content-type、内容和调用方 metadata。
 * @param options 测试或运行时可注入的 id、时间和 TXT 切块参数。
 * @returns 成功时返回 document，失败时返回结构化 ingestion error。
 */
export function ingestDocument(
  request: IngestDocumentRequest,
  options: DocumentIngestionOptions = {}
): DocumentIngestionResult {
  return parseDocument(request, options);
}

/**
 * 解析主流程 facade：detect → resolve → parse → assemble。
 *
 * 不再按格式 if/else 硬分支：文件类型检测与 parser 解析都从同一份 registry 推导，
 * 新增格式（如 docx）只需注册一个 parser，本函数零改动（开闭原则）。
 *
 * @param request ingestion 请求。
 * @param options 测试或运行时可注入的 id、时间和 TXT 切块参数。
 * @returns 成功时返回组装好的 document，失败时返回结构化 ingestion error。
 */
export function parseDocument(
  request: IngestDocumentRequest,
  options: DocumentIngestionOptions = {}
): DocumentIngestionResult {
  const fileType = detectDocumentFileType(request.fileName, request.contentType);

  if (!fileType) {
    return ingestionFailure("unknown_file_type", "无法识别文档文件类型。", {
      fileName: request.fileName,
      contentType: request.contentType ?? null
    });
  }

  const contentText = decodeContent(request.content);

  if (contentText.trim().length === 0) {
    return ingestionFailure("empty_file", "文档内容为空。", {
      fileName: request.fileName,
      fileType
    });
  }

  const parser = defaultParserRegistry.resolve(fileType);

  if (!parser) {
    return ingestionFailure("unknown_file_type", "未注册可解析该文件类型的 parser。", {
      fileName: request.fileName,
      fileType
    });
  }

  const input: ParserInput = {
    fileName: request.fileName,
    contentType: request.contentType,
    content: request.content,
    options
  };

  // magic bytes 等强校验：内容与声明的文件类型不符时直接收敛为结构化错误。
  if (parser.accepts && !parser.accepts(input)) {
    return ingestionFailure("parse_failed", "内容与声明的文件类型不匹配。", {
      fileName: request.fileName,
      fileType,
      reason: "content_type_mismatch"
    });
  }

  let blocks: ParsedBlock[];

  try {
    blocks = parser.parse(input);
  } catch (error) {
    return ingestionFailure("parse_failed", "文档解析失败。", {
      fileName: request.fileName,
      fileType,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  if (blocks.length === 0) {
    return ingestionFailure("empty_file", "文档未解析出有效文本块。", {
      fileName: request.fileName,
      fileType
    });
  }

  return {
    ok: true,
    document: buildParsedDocument(request, fileType, blocks, contentText, options)
  };
}

/**
 * 把解析出的 block 草稿组装为最终 document（桶 A：原两分支完全相同的尾部收敛为一处）。
 *
 * 负责 documentId / metadata / title / createdAt / blocks 的统一补齐，
 * 与具体解析格式无关，因此是所有 parser 共用的唯一组装点。
 *
 * @param request ingestion 请求。
 * @param fileType 已识别的文件类型。
 * @param blocks 解析阶段产出的 block 草稿。
 * @param contentText 已解码的原始文本（用于标题推导）。
 * @param options 可注入的 id / 时间。
 * @returns 补齐稳定 id 与元数据的 document。
 */
function buildParsedDocument(
  request: IngestDocumentRequest,
  fileType: DocumentFileType,
  blocks: ParsedBlock[],
  contentText: string,
  options: DocumentIngestionOptions
): ParsedDocument {
  const documentId = options.idGenerator?.(request, fileType) ?? createStableDocumentId(request, fileType);
  const metadata = normalizeMetadata(request.metadata);
  const title = resolveTitle(request.fileName, fileType, contentText, metadata);
  const createdAt = (options.now?.() ?? new Date()).toISOString();

  return {
    documentId,
    source: request.source,
    fileName: request.fileName,
    title,
    fileType,
    createdAt,
    metadata,
    blocks: blocks.map((block, index) => createTextBlock(documentId, index, block))
  };
}

/**
 * 生成稳定 document id，让无数据库场景下的测试和 demo 结果可预测。
 *
 * @param request ingestion 请求。
 * @param fileType 已识别的文件类型。
 * @returns 基于 source、fileName、fileType 和内容的稳定 id。
 */
function createStableDocumentId(request: IngestDocumentRequest, fileType: DocumentFileType): string {
  const basis = `${request.source}|${request.fileName}|${fileType}|${decodeContent(request.content)}`;

  return `document_${hashString(basis)}`;
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
  fileType: DocumentFileType,
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
function normalizeMetadata(
  metadata: Record<string, unknown> = {}
): Record<string, string | number | boolean | null> {
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
function createTextBlock(documentId: string, index: number, block: ParsedBlock): IngestedTextBlock {
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
  code: DocumentIngestionErrorCode,
  message: string,
  details: Record<string, unknown>
): DocumentIngestionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details
    } satisfies DocumentIngestionError
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
