import type { DocumentParser, ParsedBlock, ParserInput } from "../types.js";
import { collectParagraphBlocks, decodeContent, splitLines } from "../block-collector.js";

/**
 * 解析 TXT 文本块，优先按空行切分，连续长段落按固定行数拆分以控制后续 chunk 输入规模。
 *
 * 段落累积 / flush / 行号簿记交给共享骨架；本函数只保留 txt 特有差异：
 * 一个段落若超过 maxLinesPerBlock 行，则按该行数再切成多个 block。
 *
 * @param content TXT 原始文本。
 * @param maxLinesPerBlock 没有空行时每个 block 的最大行数。
 * @returns 带 1-based 行号的文本块草稿。
 */
export function parseTxtBlocks(content: string, maxLinesPerBlock = 12): ParsedBlock[] {
  const safeMaxLinesPerBlock = Math.max(1, Math.floor(maxLinesPerBlock));
  const blocks: ParsedBlock[] = [];

  collectParagraphBlocks(splitLines(content), ({ lines, lineStart, lineEnd }) => {
    for (let start = 0; start < lines.length; start += safeMaxLinesPerBlock) {
      const chunkLines = lines.slice(start, start + safeMaxLinesPerBlock);
      const blockLineStart = lineStart + start;
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
  });

  return blocks;
}

/** TXT 解析 adapter：检测与解析共用同一份 contentTypes / extensions。 */
export const TxtParser: DocumentParser = {
  fileType: "txt",
  contentTypes: ["text/plain"],
  extensions: ["txt", "text"],
  parse(input: ParserInput): ParsedBlock[] {
    const maxLinesPerBlock = input.options.txtMaxLinesPerBlock ?? 12;

    return parseTxtBlocks(decodeContent(input.content), maxLinesPerBlock);
  }
};
