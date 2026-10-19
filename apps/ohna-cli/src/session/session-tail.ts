/**
 * JSONL 尾部倒读（Phase C4）：只解码文件尾部的若干条记录。
 *
 * 为什么单独成模块：字节级反向扫描属于「文件格式基础设施」，不依赖会话领域语义
 * （消息形状校验、meta 合成仍留在 `session-store.ts`）。这样 store 保持在 500 行以内，
 * 且倒读逻辑可以脱离会话类型单独测试/复用。
 *
 * 健壮性约定（本模块的全部复杂度都来自这里）：
 * - **按字节找换行**：UTF-8 续字节范围 0x80–0xBF 不含 0x0A，因此按字节扫描换行不会
 *   切坏多字节字符；只有完整行（前后都有换行，或文件起点/终点）才会被解码。
 * - **不完整首行回填**：块边界落在行中间时，把第一段作为 carry 并入更早的块，绝不当
 *   完整行解析。因此任意块大小、CRLF、末尾无换行、连续空行都不会产生半行 JSON。
 * - **hasMore 精确**：多收集一条即可判定「更早还有记录」，无需扫到文件头；
 *   否则必须读到文件头才能确定没有更早记录（损坏行/空行不计入 n）。
 */
import { promises as fs } from "node:fs";

/** 倒读时每次读取的字节数：64KB 足够覆盖数十条常见 JSONL 记录，且不会放大内存。 */
const TAIL_READ_CHUNK = 64 * 1024;

/** 头部扫描上限：首行超过此长度视为无头部（极端文件保护，避免无限 read）。 */
const HEADER_SCAN_MAX = 64 * 1024;

/** 尾部倒读结果。 */
export interface JsonlTailResult<T> {
  /** 首行原始文本（不含换行）；文件为空 / 超长 / 无换行时 undefined。 */
  headerLine?: string;
  /** 最新的至多 n 条通过 `parse` 的记录，按文件顺序（早 → 晚）。 */
  values: T[];
  /** 更早是否仍有未返回的记录。 */
  hasMore: boolean;
}

/**
 * 从文件指定位置读取最多 `length` 字节，并循环补齐短读。
 *
 * 为什么必须循环：`FileHandle.read` 允许**短读**（返回 `bytesRead < length`），
 * 尤其在对管道 / 特殊文件读取时。若忽略 `bytesRead` 而按请求长度切片，就会把
 * `Buffer.allocUnsafe` 里未初始化的尾部字节当成文件内容解析。这里始终按实际读到的
 * 字节数推进，返回值也是有效字节的子视图，绝不暴露未初始化区域。
 *
 * 导出以便单测直接驱动短读路径（正式调用只经 {@link readJsonlTail}）。
 *
 * @param handle 已打开的文件句柄。
 * @param length 期望读取的字节数。
 * @param position 起始绝对偏移。
 * @returns 实际读到的字节子视图（长度 <= length，EOF 时更短）。
 */
export async function readExact(
  handle: import("node:fs/promises").FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(0, length));
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) break; // 提前 EOF：按已读到的字节返回。
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

/**
 * 读取文件首行原文（会话头）。
 *
 * @param handle 已打开的文件句柄。
 * @param size 文件字节数。
 * @returns 首行文本；空文件或无换行的超长首行返回 undefined。
 */
async function readHeaderLine(
  handle: import("node:fs/promises").FileHandle,
  size: number,
): Promise<string | undefined> {
  if (size <= 0) return undefined;
  const readSize = Math.min(size, HEADER_SCAN_MAX);
  const buffer = await readExact(handle, readSize, 0);
  const newline = buffer.indexOf(0x0a, 0);
  // 首行超出扫描上限（没有换行且文件还没读完）时放弃：调用方按「无头部」处理。
  if (newline < 0 && size > buffer.length) return undefined;
  const end = newline >= 0 ? newline : buffer.length;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * 从文件尾倒读，收集最近的至多 `n` 条能通过 `parse` 的完整行。
 *
 * @template T 记录类型。
 * @param filePath 文件路径。
 * @param n 期望返回的最大记录条数（非负整数）。
 * @param parse 完整行 → 记录；返回 undefined 表示损坏 / 结构不符（跳过且不计数）。
 * @returns 尾部结果；文件不存在返回 null。
 */
export async function readJsonlTail<T>(
  filePath: string,
  n: number,
  parse: (line: string) => T | undefined,
): Promise<JsonlTailResult<T> | null> {
  const limit = Math.max(0, Math.floor(n));
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const headerLine = await readHeaderLine(handle, size);
    /** 从新到旧收集；最后 slice + reverse 还原文件顺序。 */
    const newestFirst: T[] = [];
    let hasMore = false;
    let position = size;
    let carry: Buffer | undefined;

    while (true) {
      const readSize = Math.min(TAIL_READ_CHUNK, position);
      position -= readSize;
      // 读取必须按实际 bytesRead 切片（短读保护，见 {@link readExact}）：绝不解析
      // allocUnsafe 的未初始化尾部字节。
      const segment = readSize > 0 ? await readExact(handle, readSize, position) : Buffer.alloc(0);
      const buffer = carry ? Buffer.concat([segment, carry]) : segment;
      carry = undefined;
      const atStart = position === 0;

      let firstLineStart = 0;
      if (!atStart) {
        const firstNewline = buffer.indexOf(0x0a, 0);
        if (firstNewline < 0) {
          // 整块都是某个超长行的中部：整体留作 carry，继续向前读。
          carry = buffer;
          continue;
        }
        // 第一段起始于更早的块，是片断：连同换行一起回填到下一轮。
        carry = buffer.subarray(0, firstNewline + 1);
        firstLineStart = firstNewline + 1;
      }

      // 从区间末尾向前逐行解析完整行（顺序即从新到旧）。
      let segEnd = buffer.length;
      let reached = false;
      while (segEnd > firstLineStart) {
        const newline = buffer.lastIndexOf(0x0a, segEnd - 1);
        const segStart = newline >= firstLineStart ? newline + 1 : firstLineStart;
        if (segEnd > segStart) {
          const value = parse(buffer.subarray(segStart, segEnd).toString("utf8").trim());
          if (value !== undefined) {
            newestFirst.push(value);
            // 多收一条即可确认「更早还有记录」，无需继续扫到文件头。
            if (newestFirst.length === limit + 1) {
              hasMore = true;
              reached = true;
              break;
            }
          }
        }
        if (newline < firstLineStart) break;
        segEnd = newline;
      }

      if (reached) break;
      if (atStart) break;
      // 防御：readSize 为 0 且仍未到文件头时避免死循环（正常不可达）。
      if (readSize === 0) break;
    }

    // slice(0, limit) 丢弃为判定 hasMore 而多收的第 limit+1 条；reverse 还原时间顺序。
    return {
      ...(headerLine !== undefined ? { headerLine } : {}),
      values: newestFirst.slice(0, limit).reverse(),
      hasMore,
    };
  } finally {
    await handle.close();
  }
}
