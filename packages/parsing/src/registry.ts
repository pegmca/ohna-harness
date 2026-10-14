import type { DocumentFileType, DocumentParser } from "./types.js";
import { MarkdownParser } from "./parsers/markdown.js";
import { TxtParser } from "./parsers/txt.js";
import { PdfParser } from "./parsers/pdf.js";

/**
 * 解析器注册表：检测（detect）与解析（resolve）共用同一份 parser 元数据，
 * 是 contentTypes / extensions 的**单一事实来源**。
 *
 * 开闭原则：新增一种格式只需 `register` 一个 DocumentParser，
 * facade（parse-document.ts）与检测逻辑都无需改动。
 */
export class ParserRegistry {
  private readonly parsers: DocumentParser[] = [];

  /**
   * 注册一个 parser，后注册者不覆盖先注册者（检测按注册顺序取首个匹配）。
   *
   * @param parser 实现 DocumentParser 契约的解析 adapter。
   * @returns 当前 registry，便于链式注册。
   */
  register(parser: DocumentParser): this {
    this.parsers.push(parser);
    return this;
  }

  /**
   * 列出已注册 parser 的快照。
   *
   * @returns 已注册 parser 的只读副本。
   */
  list(): readonly DocumentParser[] {
    return [...this.parsers];
  }

  /**
   * 按文件类型解析出对应 parser。
   *
   * @param fileType 已识别的文件类型。
   * @returns 命中的 parser；未注册时返回 undefined。
   */
  resolve(fileType: DocumentFileType): DocumentParser | undefined {
    return this.parsers.find((parser) => parser.fileType === fileType);
  }

  /**
   * 按 content-type 优先、扩展名兜底识别文件类型。
   *
   * 与解析共用同一份 parser 元数据：能解析的格式必然能被检测出来，反之亦然。
   *
   * @param fileName adapter 传入的原始文件名。
   * @param contentType 可选 MIME 类型。
   * @returns 可解析文件类型；未知类型返回 undefined。
   */
  detect(fileName: string, contentType?: string): DocumentFileType | undefined {
    const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();

    if (normalizedContentType) {
      const byContentType = this.parsers.find((parser) => parser.contentTypes.includes(normalizedContentType));

      if (byContentType) {
        return byContentType.fileType;
      }
    }

    const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

    if (extension) {
      const byExtension = this.parsers.find((parser) => parser.extensions.includes(extension));

      if (byExtension) {
        return byExtension.fileType;
      }
    }

    return undefined;
  }
}

/** 默认注册的 parser 集合；顺序决定检测优先级（content-type / 扩展名冲突时取前者）。 */
export const DEFAULT_PARSERS: readonly DocumentParser[] = [MarkdownParser, TxtParser, PdfParser];

/** 包级默认 registry，facade 与 detectDocumentFileType 共用同一实例。 */
export const defaultParserRegistry = new ParserRegistry();

DEFAULT_PARSERS.forEach((parser) => {
  defaultParserRegistry.register(parser);
});

/**
 * 根据文件扩展名和 content-type 判断文档类型（基于默认 registry）。
 *
 * @param fileName adapter 传入的原始文件名。
 * @param contentType 可选 MIME 类型。
 * @returns 可解析文件类型；未知类型返回 undefined。
 */
export function detectDocumentFileType(fileName: string, contentType?: string): DocumentFileType | undefined {
  return defaultParserRegistry.detect(fileName, contentType);
}
