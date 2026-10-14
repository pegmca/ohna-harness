/**
 * 段落块草稿：由 collectParagraphBlocks 产出，尚未补齐 id / metadata。
 */
export interface CollectedParagraph {
  /** 段落文本（各行以 \n 连接并 trim）。 */
  text: string;
  /** 组成该段落的原始行，供需要二次切分的 parser（TXT）使用。 */
  lines: readonly string[];
  /** 段落首行的 1-based 行号。 */
  lineStart: number;
  /** 段落末行的 1-based 行号。 */
  lineEnd: number;
}

/**
 * 逐行钩子：在累积每个非空行之前调用。
 *
 * - 返回 `undefined` 表示把该行并入当前段落（默认行为）；
 * - 返回 `"skip"` 表示该行已被钩子自行处理（如 markdown heading、PDF 表格行），
 *   不并入段落。钩子可在返回前调用 `flush` 把"当前段落"先落盘，从而保证块顺序正确。
 *
 * @param line 当前行原文。
 * @param lineNumber 当前行 1-based 行号。
 * @param flush 立即落盘当前段落（行号簿记由 collector 负责），可传入期望的 lineEnd。
 */
export type ParagraphLineHandler = (
  line: string,
  lineNumber: number,
  flush: (lineEnd: number) => void
) => "skip" | undefined;

/**
 * 共享段落骨架：承担"逐行累积非空行成段落、遇空行 flush、记录 lineStart/lineEnd"的簿记。
 *
 * markdown / txt / pdf 三处原本各抄了一遍同一循环（桶 B 重复），抽到这里后三个 parser
 * 只提供 emit 回调与可选 onLine 钩子，各自保留自己的差异（heading / 长段再切 / 页码+表格行）。
 *
 * @param lines 已按行切分好的文本行（见 splitLines）。
 * @param emit 段落落盘回调，接收完整段落草稿（含原始行，便于二次切分）。
 * @param onLine 可选逐行钩子，用于强制断段并产出独立块（heading / 表格行）。
 * @returns 无返回值；结果通过 emit 回调交回调用方。
 */
export function collectParagraphBlocks(
  lines: readonly string[],
  emit: (paragraph: CollectedParagraph) => void,
  onLine?: ParagraphLineHandler
): void {
  let paragraphLines: string[] = [];
  let paragraphStart = 0;

  // 行号簿记集中在这里：paragraphStart 记录段落首行，lineEnd 由 flush 调用方传入。
  const flush = (lineEnd: number): void => {
    if (paragraphLines.length === 0) {
      paragraphStart = 0;
      return;
    }

    const text = paragraphLines.join("\n").trim();

    if (text.length > 0) {
      emit({ text, lines: paragraphLines, lineStart: paragraphStart, lineEnd });
    }

    paragraphLines = [];
    paragraphStart = 0;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.trim().length === 0) {
      flush(lineNumber - 1);
      return;
    }

    if (onLine?.(line, lineNumber, flush) === "skip") {
      return;
    }

    if (paragraphLines.length === 0) {
      paragraphStart = lineNumber;
    }

    paragraphLines.push(line);
  });

  flush(lines.length);
}

/**
 * 按平台无关方式拆分文本行，并去掉末尾由最后一个换行产生的空行。
 *
 * 低层模块定义并导出，markdown / txt / pdf 与 facade 共用同一实现，
 * 保持依赖单向（parsers → block-collector）。
 *
 * @param content 原始文本。
 * @returns 文本行数组。
 */
export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  if (lines.at(-1) === "") {
    return lines.slice(0, -1);
  }

  return lines;
}

/**
 * 将 string 或 Uint8Array 统一解码为文本，避免 package 直接依赖浏览器 File API。
 *
 * @param content adapter 传入的文件内容。
 * @returns UTF-8 文本（去除 BOM）。
 */
export function decodeContent(content: string | Uint8Array): string {
  if (typeof content === "string") {
    return content.replace(/^\uFEFF/, "");
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(content).replace(/^\uFEFF/, "");
}
