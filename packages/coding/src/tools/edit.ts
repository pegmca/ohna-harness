/**
 * edit 工具：对单个文件做精确字符串替换（唯一匹配）。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/edit.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 改动点：
 * - 剥离 pi-tui 的 renderDiff 与 extension 体系，输出只回文本 + 结构化 details；
 * - typebox schema → zod；edits[] 数组形态收敛为单组 oldText/newText（M1 只做精确替换）；
 * - 暂不引入 fuzzy 匹配与 diff npm 包，模糊匹配与 unified diff 展示留给 M3；
 * - 新增写入前置策略校验（必须在 cwd 内、不得命中敏感文件 denylist），越界抛
 *   code="permission_denied"。
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { z } from "zod";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { isDeniedPath, assertPathWithinRoot } from "../policy/path-policy.js";
import { withFileMutationQueue } from "../support/file-mutation-queue.js";
import { resolveToCwd } from "../support/path-utils.js";
import { truncateHead } from "../support/truncate.js";

/** 编辑操作的默认超时；读 + 匹配 + 写通常在毫秒级，留足大文件的余量。 */
const DEFAULT_EDIT_TIMEOUT_MS = 30_000;

/** 回显预览时保留的上下文行数（替换片段上下各 N 行）。 */
const PREVIEW_CONTEXT_LINES = 3;

/** 回显预览的行/字节上限，避免把整个文件回喂模型。 */
const PREVIEW_MAX_LINES = 40;
const PREVIEW_MAX_BYTES = 2048;

/** 预览用的 Markdown 代码围栏，避免与模板字符串的反引号冲突。 */
const PREVIEW_FENCE = "\u0060\u0060\u0060";

/** edit 工具入参 schema。 */
export const editInputSchema = z.object({
  path: z.string().min(1, "path is required").describe("Path to the file to edit (relative to cwd or absolute)"),
  oldText: z
    .string()
    .min(1, "oldText must not be empty")
    .describe(
      "Exact text to replace. It must match the file character for character, including all whitespace and newlines, " +
        "and it must occur exactly once in the file."
    ),
  newText: z.string().describe("Replacement text. Use an empty string to delete the matched text.")
});

export type EditToolInput = z.infer<typeof editInputSchema>;

/** edit 工具的结构化输出（同时作为 details 供 CLI / trace 使用）。 */
export interface EditToolOutput {
  /** 调用方传入的原始路径 */
  path: string;
  /** 解析后的绝对路径 */
  absolutePath: string;
  /** oldText 在原文件中的起始行号（1-based） */
  matchLine: number;
  /** 替换前的 UTF-8 字节数 */
  bytesBefore: number;
  /** 替换后的 UTF-8 字节数 */
  bytesAfter: number;
  /** 原文件使用的行尾；写回时保持一致 */
  lineEnding: "lf" | "crlf";
  /** 原文件是否带 BOM；带 BOM 时写回会保留 */
  hadBom: boolean;
  /** 替换结果的上下文预览（已头截断），供模型与 CLI 快速确认改动 */
  preview: string;
}

/**
 * 可插拔的文件编辑操作，默认走本地文件系统。
 * 与 pi 一致，抽出来便于把编辑委派到远端执行。
 */
export interface EditOperations {
  /** 以 UTF-8 字符串读取文件 */
  readFile: (absolutePath: string) => Promise<string>;
  /** 把内容写入指定绝对路径 */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** 校验文件可读可写，不可用时抛错 */
  access: (absolutePath: string) => Promise<void>;
}

/** edit 工具的可选项。 */
export interface EditToolOptions {
  /** 自定义文件编辑操作；默认本地文件系统 */
  operations?: EditOperations;
}

const defaultEditOperations: EditOperations = {
  readFile: (absolutePath) => fsReadFile(absolutePath, "utf-8"),
  writeFile: (absolutePath, content) => fsWriteFile(absolutePath, content, "utf-8"),
  access: async (absolutePath) => {
    await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
  }
};

/**
 * 构造带稳定 code 的 Error，供包装层转成结构化工具错误。
 *
 * @param code 结构化错误码（executor 白名单内：permission_denied / validation_error / execution_error）。
 * @param message 面向模型与用户的错误文案。
 * @returns 带 code 的 Error。
 */
function createEditError(code: "permission_denied" | "validation_error" | "execution_error", message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * 剥离 UTF-8 BOM，避免模型给出的 oldText（不含不可见 BOM）永远匹配不上。
 *
 * @param content 原始文件内容。
 * @returns BOM 与去掉 BOM 后的正文。
 */
function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * 探测文件使用的行尾，写回时还原，避免整文件换行被悄悄改写。
 *
 * @param content 去掉 BOM 后的文件内容（LF 归一前）。
 * @returns 探测到的行尾。
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) return "\n";
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

/**
 * 统计子串在内容中的出现次数（纯字符串分割，不做正则，避免转义问题）。
 *
 * @param content 被检索的内容。
 * @param needle 待统计的子串。
 * @returns 出现次数。
 */
function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  return content.split(needle).length - 1;
}

/**
 * 计算偏移量所在的行号（1-based），用于把替换位置回喂模型。
 *
 * @param content 内容（LF 归一后）。
 * @param index 字符偏移。
 * @returns 行号（首行为 1）。
 */
function lineNumberOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

/**
 * 截取替换片段及其上下若干行作为预览，并做头截断，避免把整个文件回喂模型。
 *
 * @param content 替换后的完整内容（LF 归一）。
 * @param startIndex 替换片段起始偏移。
 * @param endIndex 替换片段结束偏移（不含）。
 * @returns 截断后的预览文本。
 */
function buildPreview(content: string, startIndex: number, endIndex: number): string {
  const lines = content.split("\n");
  const startLine = lineNumberOf(content, startIndex) - 1;
  const endLine = lineNumberOf(content, endIndex) - 1;
  const from = Math.max(0, startLine - PREVIEW_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + 1 + PREVIEW_CONTEXT_LINES);

  const body = lines
    .slice(from, to)
    .map((line, offset) => `${from + offset + 1}| ${line}`)
    .join("\n");

  const truncated = truncateHead(body, { maxLines: PREVIEW_MAX_LINES, maxBytes: PREVIEW_MAX_BYTES });
  const omitted = to - from - truncated.outputLines;
  const suffix = truncated.truncated ? `\n... (${omitted} more lines omitted)` : "";
  return `${PREVIEW_FENCE}\n${truncated.content}${suffix}\n${PREVIEW_FENCE}`;
}

/**
 * 校验编辑目标路径是否被允许：必须落在 root 目录内，且不能命中敏感文件 denylist。
 *
 * @param absolutePath 解析后的绝对路径。
 * @param root 允许写入的根目录（即工具绑定的 cwd）。
 * @throws 越界或命中 denylist 时抛出 code="permission_denied" 的 Error。
 */
function assertEditablePath(absolutePath: string, root: string): void {
  if (isDeniedPath(absolutePath)) {
    throw createEditError(
      "permission_denied",
      `Editing ${absolutePath} is denied: the path is a sensitive or generated location.`
    );
  }

  const withinRoot = assertPathWithinRoot(absolutePath, root);
  if (!withinRoot.ok) {
    throw createEditError("permission_denied", `Editing ${absolutePath} is denied: ${withinRoot.reason}`);
  }
}

/**
 * 创建精确替换编辑工具。
 *
 * @param cwd 工作目录：相对路径按它解析，同时也是允许写入的根目录。
 * @param options 可选自定义 fs 操作。
 * @returns 可直接注册进工具表的 AgentTool。
 */
export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editInputSchema, EditToolOutput> {
  const ops = options?.operations ?? defaultEditOperations;

  return defineAgentTool<typeof editInputSchema, EditToolOutput>({
    name: "edit",
    label: "edit",
    description:
      "Edit an existing file by replacing an exact text block. oldText must match the file exactly " +
      "(including whitespace and newlines) and must be unique in the file. Use read first to get the exact content. " +
      "Use write instead for new files or complete rewrites.",
    parameters: editInputSchema,
    // 写操作不可重试：第二次执行会因 oldText 已被替换而失败或产生重复改动。
    execution: { hasSideEffects: true, timeoutMs: DEFAULT_EDIT_TIMEOUT_MS },
    source: "real",
    formatResult: (output) =>
      `Successfully replaced 1 block in ${output.path} (line ${output.matchLine}).` +
      `\n${output.bytesBefore} -> ${output.bytesAfter} bytes, line endings: ${output.lineEnding}` +
      (output.hadBom ? ", BOM preserved" : "") +
      `\nabsolute path: ${output.absolutePath}` +
      `\n${output.preview}`,
    /**
     * 执行一次精确替换：路径解析 → 策略校验 → 队列串行化 → 读 → 匹配 → 写回。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级取消信号。
     * @returns 替换位置与字节变化等结构化结果。
     */
    async execute(params, signal) {
      const { path, oldText, newText } = params;
      const absolutePath = resolveToCwd(path, cwd);
      assertEditablePath(absolutePath, cwd);

      if (oldText === newText) {
        throw createEditError("validation_error", `oldText and newText are identical in ${path}; no change to apply.`);
      }

      return withFileMutationQueue(absolutePath, async () => {
        // 与 write 同理：不在 abort 事件里直接 reject，避免 fs 未 settled 就释放队列锁。
        const throwIfAborted = (): void => {
          if (signal?.aborted) {
            throw createEditError("execution_error", "Operation aborted");
          }
        };

        throwIfAborted();

        // 文件必须先存在且可读写：edit 只做局部替换，不负责创建文件。
        try {
          await ops.access(absolutePath);
        } catch (error) {
          throwIfAborted();
          const reason = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
          throw createEditError("execution_error", `Could not edit file: ${path}. ${reason}. Use write to create it.`);
        }
        throwIfAborted();

        const rawContent = await ops.readFile(absolutePath);
        throwIfAborted();

        // 先去 BOM（模型不会把不可见 BOM 写进 oldText），再统一按 LF 匹配。
        const { bom, text } = stripBom(rawContent);
        const lineEndingRaw = detectLineEnding(text);
        const content = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const normalizedOldText = oldText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const normalizedNewText = newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        const matchIndex = content.indexOf(normalizedOldText);
        if (matchIndex === -1) {
          // 0 次命中：把可操作信息回喂模型，提示它重新 read 后再试。
          throw createEditError(
            "validation_error",
            `Could not find the exact text in ${path}. oldText must match exactly, including all whitespace and newlines. ` +
              `Call read on ${path} and copy the text verbatim, then retry with a smaller unique block.`
          );
        }

        const occurrences = countOccurrences(content, normalizedOldText);
        if (occurrences > 1) {
          // 多于 1 次命中：明确告知次数，让模型补充上下文使其唯一。
          throw createEditError(
            "validation_error",
            `Found ${occurrences} occurrences of the text in ${path}. oldText must be unique. ` +
              `Include more surrounding lines (for example the enclosing function signature) to make it unique.`
          );
        }

        const newContent =
          content.slice(0, matchIndex) + normalizedNewText + content.slice(matchIndex + normalizedOldText.length);
        throwIfAborted();

        // 还原原始行尾与 BOM，避免把无关差异混进改动。
        const restored = lineEndingRaw === "\r\n" ? newContent.replace(/\n/g, "\r\n") : newContent;
        const finalContent = bom + restored;

        try {
          await ops.writeFile(absolutePath, finalContent);
        } catch (error) {
          const reason = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
          throw createEditError("execution_error", `Could not write file: ${path}. ${reason}`);
        }
        throwIfAborted();

        return {
          path,
          absolutePath,
          matchLine: lineNumberOf(content, matchIndex),
          bytesBefore: Buffer.byteLength(rawContent, "utf-8"),
          bytesAfter: Buffer.byteLength(finalContent, "utf-8"),
          lineEnding: lineEndingRaw === "\r\n" ? "crlf" : "lf",
          hadBom: bom.length > 0,
          preview: buildPreview(newContent, matchIndex, matchIndex + normalizedNewText.length)
        };
      });
    }
  });
}
