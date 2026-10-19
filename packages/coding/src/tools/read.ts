/**
 * read 工具：读取文件内容（只读，无任何写副作用）。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/read.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 移植改造：typebox → zod v4；剥离 pi-tui 渲染、图像读取、keybinding hints 与 ExtensionContext；
 * 新增 assertPathWithinRoot / isDeniedPath 只读沙箱校验；输出带行号前缀，便于模型引用行号。
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import { assertPathWithinRoot, isDeniedPath } from "../policy/path-policy.js";
import { resolveReadPathAsync } from "../support/path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
} from "../support/truncate.js";
import { replaceTabs } from "../support/text-utils.js";

/** read 工具入参 schema（description 用英文便于模型理解，补中文说明便于人读）。 */
export const readInputSchema = z.object({
  path: z.string().min(1).describe("Path to the file to read (relative or absolute)。待读取文件路径，相对路径按工作目录解析"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-indexed)。起始行号，从 1 开始"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to read。最多读取的行数"),
});

/** read 工具入参类型。 */
export type ReadInput = z.infer<typeof readInputSchema>;

/** read 工具结构化输出（同时作为 details 回传，供 trace/UI 使用）。 */
export interface ReadOutput {
  /** 解析后的绝对路径。 */
  path: string;
  /** 带行号前缀、已截断的文本，即回喂模型的内容。 */
  output: string;
  /** 本次实际输出的起始行号（1-indexed）。 */
  startLine: number;
  /** 本次实际输出的结束行号（1-indexed）。 */
  endLine: number;
  /** 文件总行数。 */
  totalLines: number;
  /** 截断信息；未截断时缺省。 */
  truncation?: TruncationResult;
}

/** read 工具可选项。 */
export interface ReadToolOptions {
  /** 覆盖默认字节上限（默认 DEFAULT_MAX_BYTES = 50KB）。 */
  maxBytes?: number;
  /** 覆盖默认行数上限（默认 DEFAULT_MAX_LINES = 2000）。 */
  maxLines?: number;
}

/** 嗅探前若干字节判断是否为二进制文件，避免把乱码灌进模型上下文。 */
const BINARY_SNIFF_BYTES = 4096;

/**
 * 校验路径是否允许读取：必须落在工作目录内且不属于敏感文件。
 *
 * @param absolutePath 已解析的绝对路径。
 * @param cwd 工作目录（沙箱根）。
 * @throws 越界或命中敏感文件时抛出 code 为 permission_denied 的结构化错误。
 */
function assertReadable(absolutePath: string, cwd: string): void {
  const withinRoot = assertPathWithinRoot(absolutePath, cwd);
  if (!withinRoot.ok) {
    throw Object.assign(new Error(`Read denied: ${withinRoot.reason}`), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }

  if (isDeniedPath(absolutePath)) {
    throw Object.assign(new Error(`Read denied: ${absolutePath} is a sensitive path`), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }
}

/**
 * 给选中内容加上行号前缀，制表符统一替换成空格避免换行错位。
 *
 * @param content 已截断的纯文本内容。
 * @param startLine 内容第一行的文件行号（1-indexed）。
 * @returns 每行形如 `12\tcode` 的带行号文本。
 */
function withLineNumbers(content: string, startLine: number): string {
  return content
    .split("\n")
    .map((line, index) => `${startLine + index}\t${replaceTabs(line)}`)
    .join("\n");
}

/**
 * 按 offset/limit 选取行区间，超限时用 truncateHead 截断并生成可执行的续读提示。
 *
 * @param allLines 文件全部行。
 * @param offset 1-indexed 起始行号。
 * @param limit 用户指定读取行数。
 * @param options 字节/行数上限。
 * @returns 纯文本输出、截断信息与实际输出的行号区间。
 */
function selectAndTruncate(
  allLines: string[],
  offset: number | undefined,
  limit: number | undefined,
  options: TruncationOptions,
): { output: string; truncation?: TruncationResult; startLine: number; endLine: number } {
  const totalFileLines = allLines.length;
  // offset 从 1-indexed 输入转成 0-indexed 数组下标。
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;

  if (startLine >= totalFileLines) {
    throw Object.assign(
      new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`),
      { code: "execution_error" },
    );
  }

  const endIndex = limit === undefined ? totalFileLines : Math.min(startLine + limit, totalFileLines);
  const selectedContent = allLines.slice(startLine, endIndex).join("\n");
  const truncation = truncateHead(selectedContent, options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  if (truncation.firstLineExceedsLimit) {
    // 单行就超过字节上限：不回喂内容，只给定位信息，避免上下文爆炸。
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
    return {
      output: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(maxBytes)} limit. Use bash: sed -n '${startLineDisplay}p' | head -c ${maxBytes}]`,
      truncation,
      startLine: startLineDisplay,
      endLine: startLineDisplay,
    };
  }

  const endLineDisplay = startLineDisplay + Math.max(truncation.outputLines, 1) - 1;
  let output = withLineNumbers(truncation.content, startLineDisplay);

  if (truncation.truncated) {
    const nextOffset = endLineDisplay + 1;
    const reason =
      truncation.truncatedBy === "lines"
        ? `${options.maxLines ?? DEFAULT_MAX_LINES} lines limit`
        : `${formatSize(maxBytes)} limit`;
    output += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${reason}). Use offset=${nextOffset} to continue.]`;
    return { output, truncation, startLine: startLineDisplay, endLine: endLineDisplay };
  }

  // 截断未发生但用户 limit 提前结束：提示剩余行数与续读 offset。
  if (endIndex < totalFileLines) {
    const remaining = totalFileLines - endIndex;
    output += `\n\n[${remaining} more lines in file. Use offset=${endIndex + 1} to continue.]`;
  }

  return { output, startLine: startLineDisplay, endLine: endLineDisplay };
}

/**
 * 创建 read 工具：读取文本文件内容，支持 offset/limit 分段读大文件。
 *
 * @param cwd 工作目录（同时是只读沙箱根，越界路径一律拒绝）。
 * @param options 可选覆盖字节/行数上限。
 * @returns 可直接注入注册表的 AgentTool。
 */
export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readInputSchema, ReadOutput> {
  const truncationOptions: TruncationOptions = {
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
    maxLines: options?.maxLines ?? DEFAULT_MAX_LINES,
  };
  const maxBytes = truncationOptions.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = truncationOptions.maxLines ?? DEFAULT_MAX_LINES;

  return defineAgentTool({
    name: "read",
    description:
      `Read the contents of a text file. Output is prefixed with line numbers and truncated to ${maxLines} lines or ` +
      `${Math.floor(maxBytes / 1024)}KB (whichever is hit first). Use offset/limit for large files and continue with offset.`,
    label: "read",
    parameters: readInputSchema,
    // 只读：不进入权限问询（effect 为权限体系的单一事实源）。
    effect: "read",
    source: "real",
    execution: { timeoutMs: 15_000, hasSideEffects: false, idempotent: true },
    formatResult: (output) => output.output,
    /**
     * 读取文件：解析路径 → 沙箱校验 → 可读性检查 → 二进制嗅探 → 分段 + 截断。
     *
     * @param params 已通过 zod 校验的入参。
     * @returns 带行号的文本与截断信息。
     */
    async execute(params) {
      const absolutePath = await resolveReadPathAsync(params.path, cwd);
      assertReadable(absolutePath, cwd);

      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch {
        throw Object.assign(new Error(`Cannot read file: ${absolutePath}`), {
          code: "execution_error",
          details: { path: absolutePath },
        });
      }

      const buffer = await fsReadFile(absolutePath);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        throw Object.assign(new Error(`Binary file, use bash to inspect: ${absolutePath}`), {
          code: "execution_error",
          details: { path: absolutePath },
        });
      }

      const allLines = buffer.toString("utf-8").split("\n");
      if (allLines.length === 1 && allLines[0] === "") {
        return { path: absolutePath, output: "(empty file)", startLine: 1, endLine: 1, totalLines: 1 };
      }

      const selected = selectAndTruncate(allLines, params.offset, params.limit, truncationOptions);

      return {
        path: absolutePath,
        output: selected.output,
        startLine: selected.startLine,
        endLine: selected.endLine,
        totalLines: allLines.length,
        ...(selected.truncation ? { truncation: selected.truncation } : {}),
      };
    },
  });
}
