import type { DocumentParser, ParsedBlock, ParserInput } from "../types.js";
import { collectParagraphBlocks, decodeContent, splitLines } from "../block-collector.js";

/**
 * 解析 Markdown 文本块，保留最近 heading 和 1-based 行号，供后续 chunk 引用原文位置。
 *
 * 段落累积 / flush / 行号簿记交给共享骨架 collectParagraphBlocks；本函数只保留
 * markdown 特有差异：遇到 `#`~`######` 标题时先断段、更新当前 heading，并把标题本身
 * 作为一个 `blockRole: "heading"` 的独立块产出。
 *
 * @param content Markdown 原始文本。
 * @returns 带 heading 线索的文本块草稿。
 */
export function parseMarkdownBlocks(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let currentHeading: string | undefined;

  collectParagraphBlocks(
    splitLines(content),
    ({ text, lineStart, lineEnd }) => {
      blocks.push({ text, heading: currentHeading, lineStart, lineEnd });
    },
    (line, lineNumber, flush) => {
      const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);

      if (!headingMatch) {
        return undefined;
      }

      // 先把上一段（使用旧的 currentHeading）落盘，再更新 heading，保证块顺序与语义正确。
      flush(lineNumber - 1);
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
      return "skip";
    }
  );

  return blocks;
}

/** Markdown 解析 adapter：检测与解析共用同一份 contentTypes / extensions。 */
export const MarkdownParser: DocumentParser = {
  fileType: "markdown",
  contentTypes: ["text/markdown", "text/x-markdown"],
  extensions: ["md", "markdown"],
  parse(input: ParserInput): ParsedBlock[] {
    return parseMarkdownBlocks(decodeContent(input.content));
  }
};
