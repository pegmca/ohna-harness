/**
 * 工具输出截断公共能力（ported from pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * 两个相互独立的限制——先触发哪个就按哪个截断：
 * - 行数上限（默认 2000 行）
 * - 字节上限（默认 50KB）
 *
 * 除 bash 尾截断的极端场景外，绝不返回半行内容。原因是回喂模型的文本一旦出现半行，
 * 模型很容易据此误判文件结构并写出错误补丁。
 */

/** 默认最大行数。 */
export const DEFAULT_MAX_LINES = 2000;
/** 默认最大字节数（50KB）。 */
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** grep 单行匹配的最大字符数。 */
export const GREP_MAX_LINE_LENGTH = 500;

/** 截断结果：既带回喂文本，也带上「是否被截断 / 被什么限制截断」的元数据，供工具生成提示语。 */
export interface TruncationResult {
  /** 截断后的文本。 */
  content: string;
  /** 是否发生截断。 */
  truncated: boolean;
  /** 命中的限制类型：未截断时为 null。 */
  truncatedBy: "lines" | "bytes" | null;
  /** 原始内容总行数。 */
  totalLines: number;
  /** 原始内容总字节数。 */
  totalBytes: number;
  /** 截断输出中的完整行数。 */
  outputLines: number;
  /** 截断输出的实际字节数。 */
  outputBytes: number;
  /** 末行是否为半行（仅尾部截断的极端场景为 true）。 */
  lastLinePartial: boolean;
  /** 首行是否单独就超过字节上限（仅头部截断会为 true）。 */
  firstLineExceedsLimit: boolean;
  /** 实际生效的行数上限。 */
  maxLines: number;
  /** 实际生效的字节上限。 */
  maxBytes: number;
}

/** 截断可选参数。 */
export interface TruncationOptions {
  /** 最大行数，默认 2000。 */
  maxLines?: number;
  /** 最大字节数，默认 50KB。 */
  maxBytes?: number;
}

/**
 * 切分文本用于行数统计；结尾换行不额外计一行（对齐 wc -l 的直觉）。
 *
 * @param content 原始内容。
 * @returns 行数组。
 */
function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

/**
 * 把字节数格式化为人类可读尺寸。
 *
 * @param bytes 字节数。
 * @returns 形如 512B / 12.3KB / 1.5MB 的字符串。
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

/**
 * 从头部截断（保留开头 N 行 / N 字节），适合 read 这类「先看文件开头」的场景。
 * 绝不返回半行：若首行单独就超过字节上限，返回空内容并把 firstLineExceedsLimit 置 true。
 *
 * @param content 原始内容。
 * @param options 行数 / 字节上限。
 * @returns 截断结果。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  // 两个限制都没命中，直接原样返回
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // 首行单独超限：无法给出任何完整行
  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  // 从头部累计完整行，累计到超限即停
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // 换行符占 1 字节

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * 从尾部截断（保留末尾 N 行 / N 字节），适合 bash 这类「错误与最终结果在最后」的场景。
 * 极端情况下（末行本身就超过字节上限）会返回半行的尾部文本，并用 lastLinePartial 标记。
 *
 * @param content 原始内容。
 * @param options 行数 / 字节上限。
 * @returns 截断结果。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // 从尾部往前累加
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      // 极端场景：一行都还没收进来，就取该行的末尾片段（半行）
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * 从字符串末尾保留指定字节数；正确处理多字节 UTF-8 字符边界，避免切出乱码。
 *
 * @param str 原始字符串。
 * @param maxBytes 保留的字节数。
 * @returns 末尾片段。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) {
    return str;
  }

  let start = buf.length - maxBytes;
  // 前移到合法 UTF-8 字符起点（跳过续字节 0b10xxxxxx）
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }

  return buf.slice(start).toString("utf-8");
}

/**
 * 把单行截断到指定字符数，并追加 [truncated] 标记，用于 grep 的长匹配行。
 *
 * @param line 原始行。
 * @param maxChars 最大字符数，默认 500。
 * @returns 截断后的文本与是否发生截断。
 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
