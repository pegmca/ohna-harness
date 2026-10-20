/**
 * bash 输出累加器（参考自 pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * 设计要点：命令输出可能非常大（构建日志、测试全量输出），但回喂模型的只需要「尾部若干行」。
 * 所以这里用有界内存滚动保留解码后的尾部文本用于展示 / 回喂，一旦超阈值就把**完整原始字节**
 * 落到临时文件，供人或后续工具查看完整输出。
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.js";

/** 累加器构造参数。 */
export interface OutputAccumulatorOptions {
  /** 保留的最大行数，默认 DEFAULT_MAX_LINES。 */
  maxLines?: number;
  /** 保留的最大字节数，默认 DEFAULT_MAX_BYTES。 */
  maxBytes?: number;
  /** 溢出临时文件的前缀名。 */
  tempFilePrefix?: string;
}

/** 某一时刻的输出快照。 */
export interface OutputSnapshot {
  /** 截断后可直接回喂模型的文本。 */
  content: string;
  /** 截断元数据。 */
  truncation: TruncationResult;
  /** 完整输出落盘路径（仅在溢出时存在）。 */
  fullOutputPath?: string;
}

/**
 * 生成溢出临时文件的路径。
 *
 * @param prefix 文件名前缀。
 * @returns 临时目录下的日志文件路径。
 */
function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

/**
 * 计算字符串 UTF-8 字节数。
 *
 * @param text 输入文本。
 * @returns 字节数。
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/** 增量累积流式输出，内存占用有界。 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  /** 流式解码器：分块到达时保留跨块的多字节字符。 */
  private readonly decoder = new TextDecoder();

  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  /**
   * 创建累加器。
   *
   * @param options 行数 / 字节上限与临时文件前缀。
   */
  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // 滚动窗口取两倍上限，保证最后一次截断仍能拿到足够尾部内容
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "aiagent-output";
  }

  /**
   * 追加一段原始输出字节。
   *
   * @param data 子进程 stdout/stderr 的数据块。
   */
  append(data: Buffer): void {
    if (this.finished) {
      throw new Error("Cannot append to a finished output accumulator");
    }

    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  /**
   * 以文本形式追加一行；等价于 append(Buffer) 的行语义便捷封装。
   *
   * @param text 文本内容（不含换行符）。
   */
  appendLine(text: string): void {
    this.append(Buffer.from(`${text}\n`, "utf-8"));
  }

  /** 标记输出结束，冲刷流式解码器中的残留字符。 */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
  }

  /** finish 的同义别名，便于与「终结算子」语义的调用方对齐。 */
  finalize(): void {
    this.finish();
  }

  /**
   * 取当前快照（尾部截断后的文本 + 元数据）。
   *
   * @param options.persistIfTruncated 发生截断时强制把完整输出落盘。
   * @returns 输出快照。
   */
  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };

    if (options.persistIfTruncated && truncation.truncated) {
      this.ensureTempFile();
    }

    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  /**
   * 关闭并冲刷溢出临时文件（此前已写入的内容才可见）。
   *
   * @returns Promise，完成时临时文件已落盘。
   */
  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) {
      return;
    }

    const stream = this.tempFileStream;
    this.tempFileStream = undefined;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  /**
   * 当前未完成行的字节数，供调用方判断是否需要追加换行。
   *
   * @returns 末行字节数。
   */
  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  /**
   * 把解码后的文本并入统计与滚动尾部窗口。
   *
   * @param text 解码后的增量文本。
   */
  private appendDecodedText(text: string): void {
    if (text.length === 0) {
      return;
    }

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail();
    }

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  /** 把滚动尾部窗口裁剪回 maxRollingBytes 字节，并从合法 UTF-8 边界开始。 */
  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }

    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  /**
   * 取用于快照的尾部文本；若窗口不是从行首开始，丢弃第一段半行。
   *
   * @returns 可用于截断的尾部文本。
   */
  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) {
      return this.tailText;
    }

    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  /**
   * 是否需要启用临时文件保留完整输出。
   *
   * @returns 已超任意阈值时为 true。
   */
  private shouldUseTempFile(): boolean {
    return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  /** 惰性创建临时文件，并把此前缓存的原始块补写进去。 */
  private ensureTempFile(): void {
    if (this.tempFilePath) {
      return;
    }
    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}
