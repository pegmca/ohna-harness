/**
 * grep 工具：按正则/字面量搜索文件内容（只读，无任何写副作用）。
 *
 * 参考自 pi (badlogic/packages/coding-agent/src/core/tools/grep.ts)，MIT License，
 * 依 MIT License（Copyright (c) 2025 Mario Zechner）致谢 pi 原作者。
 * 移植改造：typebox → zod v4；剥离 pi-tui 渲染与 ExtensionContext；
 * 不依赖 rg 二进制（pi 用 ensureTool 下载），改为 Node 原生 readdir 递归 + 逐文件行匹配，
 * 保证零安装可跑；新增 assertPathWithinRoot / isDeniedPath 只读沙箱校验。
 */
import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import { assertPathWithinRoot, isDeniedPath } from "../policy/path-policy.js";
import { pathExists, resolveToCwd } from "../support/path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "../support/truncate.js";

/** 默认匹配数上限，与 pi 一致（超过提示放大 headLimit 或收窄 pattern）。 */
const DEFAULT_LIMIT = 100;

/** 递归扫描时直接跳过的目录（等价 pi 里 rg 忽略 .gitignore 的兜底行为）。 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "coverage"]);

/** 单文件大于该字节数时跳过，避免巨型文件拖垮单次搜索。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 正则元字符集，用于字面量搜索时转义 pattern。 */
const REGEXP_META = /[.*+?^$|()[\]\\{}]/g;

/** grep 工具入参 schema（description 用英文便于模型理解，补中文说明便于人读）。 */
export const grepInputSchema = z.object({
  pattern: z.string().min(1).describe("Search pattern (regex by default)。搜索模式，默认按正则解析"),
  path: z.string().optional().describe("File or directory to search (default: current directory)。搜索根，默认工作目录"),
  include: z.string().optional().describe("Only search files matching this glob, e.g. '*.ts'。按 glob 过滤文件"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search (-i, default: false)。忽略大小写"),
  literal: z.boolean().optional().describe("Treat pattern as literal string instead of regex (default: false)。按字面量匹配"),
  showLineNumbers: z.boolean().optional().describe("Prefix matches with line numbers (-n, default: true)。是否输出行号"),
  context: z.number().int().min(0).optional().describe("Lines of context before and after each match (default: 0)。上下文行数"),
  headLimit: z.number().int().min(1).optional().describe("Maximum number of matches to return (default: 100)。最多返回匹配数"),
});

/** grep 工具入参类型。 */
export type GrepInput = z.infer<typeof grepInputSchema>;

/** grep 工具结构化输出（同时作为 details 回传）。 */
export interface GrepOutput {
  /** 搜索根绝对路径。 */
  path: string;
  /** 已截断的匹配文本，即回喂模型的内容。 */
  output: string;
  /** 命中匹配的条数。 */
  matchCount: number;
  /** 扫描过的文件数。 */
  filesScanned: number;
  /** 命中匹配上限时回传该上限值。 */
  matchLimitReached?: number;
  /** 存在被 truncateLine 截断的长行。 */
  linesTruncated?: boolean;
  /** 命中字节上限时回传截断信息。 */
  truncation?: TruncationResult;
}

/** grep 工具可选项。 */
export interface GrepToolOptions {
  /** 覆盖默认字节上限（默认 DEFAULT_MAX_BYTES = 50KB）。 */
  maxBytes?: number;
}

/**
 * 转义正则元字符，用于 literal 模式把用户输入当纯文本匹配。
 *
 * @param value 原始字符串。
 * @returns 转义后可安全放进 RegExp 的字符串。
 */
function escapeRegExp(value: string): string {
  return value.replace(REGEXP_META, "\\$&");
}

/**
 * 校验搜索根是否允许搜索：必须落在工作目录内且不属于敏感路径。
 *
 * @param absolutePath 已解析的绝对路径。
 * @param cwd 工作目录（沙箱根）。
 * @throws 越界或命中敏感路径时抛出 code 为 permission_denied 的结构化错误。
 */
function assertSearchable(absolutePath: string, cwd: string): void {
  const withinRoot = assertPathWithinRoot(absolutePath, cwd);
  if (!withinRoot.ok) {
    throw Object.assign(new Error("Search denied: " + withinRoot.reason), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }

  if (isDeniedPath(absolutePath)) {
    throw Object.assign(new Error("Search denied: " + absolutePath + " is a sensitive path"), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }
}

/**
 * 把 glob 转成正则：** 跨目录、* 不跨目录、? 单字符，其余字符按字面量转义。
 *
 * @param glob glob 模式串。
 * @returns 用于全量匹配的正则（不带 g，避免 test 的 lastIndex 副作用）。
 */
function globToRegExp(glob: string): RegExp {
  let source = "";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];

    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        // **/ 表示「零到多层目录」，单独 ** 视为任意字符。
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp("^" + source + "$");
}

/**
 * 判断文件是否命中 include glob：不带 / 的模式只比文件名，带 / 的模式比相对路径。
 *
 * @param pattern include glob，为空表示不过滤。
 * @param basename 文件名。
 * @param relativePath 相对搜索根的 posix 路径。
 * @returns 命中返回 true。
 */
function matchesInclude(pattern: string | undefined, basename: string, relativePath: string): boolean {
  if (!pattern) return true;
  const regexp = globToRegExp(pattern);
  return pattern.includes("/") ? regexp.test(relativePath) : regexp.test(basename);
}

/**
 * 把路径分隔符统一成 posix 风格，保证输出跨平台稳定。
 *
 * @param value 路径字符串。
 * @returns 以 / 分隔的路径。
 */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * 递归收集待搜索文件；跳过忽略目录、敏感路径与超限文件。
 *
 * @param root 搜索根（文件或目录）。
 * @param include include glob。
 * @param signal 取消信号。
 * @returns 待搜索文件的绝对路径列表（已排序）。
 */
async function collectFiles(root: string, include: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const rootStat = await fsStat(root);
  if (!rootStat.isDirectory()) {
    return isDeniedPath(root) ? [] : [root];
  }

  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { code: "cancelled" });
    }

    const current = stack.pop();
    if (!current) break;
    if (current.depth > 32) continue;

    // 不可读目录返回空条目，保证整次搜索不被单点权限问题中断。
    const entries = await fsReaddir(current.dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".") || isDeniedPath(fullPath)) {
          continue;
        }
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile() || isDeniedPath(fullPath)) continue;
      if (!matchesInclude(include, entry.name, toPosix(path.relative(root, fullPath)))) continue;

      const fileStat = await fsStat(fullPath).catch(() => undefined);
      if (fileStat && fileStat.size > MAX_FILE_BYTES) continue;

      files.push(fullPath);
    }
  }

  return files.sort();
}

/**
 * 扫描单个文件，产出 path:line: text 形式的匹配行（上下文行用 path-line- text）。
 *
 * @param filePath 文件绝对路径。
 * @param displayPath 输出中展示的相对路径。
 * @param matcher 行匹配正则（不带 g 标志）。
 * @param context 上下文行数。
 * @param showLineNumbers 是否输出行号。
 * @param remaining 本文件最多还能采集的匹配数。
 * @returns 输出行、命中的匹配数与长行截断标记。
 */
async function scanFile(
  filePath: string,
  displayPath: string,
  matcher: RegExp,
  context: number,
  showLineNumbers: boolean,
  remaining: number,
): Promise<{ lines: string[]; matchCount: number; linesTruncated: boolean }> {
  const lines: string[] = [];
  let matchCount = 0;
  let linesTruncated = false;
  let lastEmitted = -1;

  const content = await fsReadFile(filePath, "utf-8").catch(() => undefined);
  // 读不到或疑似二进制（含 NUL 字节）的文件直接跳过。
  if (content === undefined || content.includes("\0")) {
    return { lines, matchCount, linesTruncated };
  }

  const fileLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (let index = 0; index < fileLines.length; index += 1) {
    if (matchCount >= remaining) break;
    if (!matcher.test(fileLines[index])) continue;

    matchCount += 1;
    const start = context > 0 ? Math.max(0, index - context) : index;
    const end = context > 0 ? Math.min(fileLines.length - 1, index + context) : index;

    // 相邻匹配的上下文会重叠，用 lastEmitted 去重，避免重复输出同一行。
    for (let cursor = Math.max(start, lastEmitted + 1); cursor <= end; cursor += 1) {
      const truncated = truncateLine(fileLines[cursor]);
      if (truncated.wasTruncated) linesTruncated = true;
      const isMatchLine = cursor === index;
      const prefix = isMatchLine
        ? showLineNumbers
          ? ":" + (cursor + 1) + ": "
          : ": "
        : showLineNumbers
          ? "-" + (cursor + 1) + "- "
          : "- ";
      lines.push(displayPath + prefix + truncated.text);
      lastEmitted = cursor;
    }
  }

  return { lines, matchCount, linesTruncated };
}

/**
 * 创建 grep 工具：在文件内容里搜索 pattern，输出带文件路径与行号。
 *
 * @param cwd 工作目录（同时是只读沙箱根）。
 * @param options 可选覆盖字节上限。
 * @returns 可直接注入注册表的 AgentTool。
 */
export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepInputSchema, GrepOutput> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  return defineAgentTool({
    name: "grep",
    description:
      "Search file contents for a pattern (regex by default). Returns matching lines with file paths and line numbers. " +
      "Skips node_modules/.git/hidden directories. Output is truncated to " +
      DEFAULT_LIMIT +
      " matches or " +
      Math.floor(maxBytes / 1024) +
      "KB (whichever is hit first); long lines are truncated to " +
      GREP_MAX_LINE_LENGTH +
      " chars.",
    label: "grep",
    parameters: grepInputSchema,
    effect: "read",
    source: "real",
    execution: { timeoutMs: 30_000, hasSideEffects: false, idempotent: true },
    formatResult: (output) => output.output,
    /**
     * 搜索文件内容：解析路径 → 沙箱校验 → 递归收集文件 → 逐文件行匹配 → 截断。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级取消信号，在文件边界检查。
     * @returns 匹配文本与统计/截断信息。
     */
    async execute(params, signal) {
      const searchPath = resolveToCwd(params.path || ".", cwd);
      assertSearchable(searchPath, cwd);

      if (!(await pathExists(searchPath))) {
        throw Object.assign(new Error("Path not found: " + searchPath), {
          code: "execution_error",
          details: { path: searchPath },
        });
      }

      let matcher: RegExp;
      try {
        // 不带 g 标志：matcher 会被逐行复用，g 会因 lastIndex 造成漏匹配。
        matcher = new RegExp(params.literal ? escapeRegExp(params.pattern) : params.pattern, params.ignoreCase ? "i" : "");
      } catch (error) {
        throw Object.assign(new Error("Invalid pattern: " + (error as Error).message), {
          code: "validation_error",
          details: { pattern: params.pattern },
        });
      }

      const effectiveLimit = params.headLimit ?? DEFAULT_LIMIT;
      const context = params.context && params.context > 0 ? params.context : 0;
      const showLineNumbers = params.showLineNumbers ?? true;
      const searchStat = await fsStat(searchPath);
      const isDirectorySearch = searchStat.isDirectory();
      const files = await collectFiles(searchPath, params.include, signal);

      const outputLines: string[] = [];
      let totalMatches = 0;
      let matchLimitReached: number | undefined;
      let linesTruncated = false;
      let filesScanned = 0;

      for (const file of files) {
        if (signal?.aborted) {
          throw Object.assign(new Error("Operation aborted"), { code: "cancelled" });
        }
        if (totalMatches >= effectiveLimit) {
          matchLimitReached = effectiveLimit;
          break;
        }

        filesScanned += 1;
        const displayPath = isDirectorySearch ? toPosix(path.relative(searchPath, file)) : path.basename(file);
        const scanned = await scanFile(
          file,
          displayPath,
          matcher,
          context,
          showLineNumbers,
          effectiveLimit - totalMatches,
        );

        outputLines.push(...scanned.lines);
        totalMatches += scanned.matchCount;
        linesTruncated = linesTruncated || scanned.linesTruncated;
      }

      if (totalMatches === 0) {
        return { path: searchPath, output: "No matches found", matchCount: 0, filesScanned };
      }

      // 匹配条数已被 headLimit 约束，这里只保留字节上限（行数上限关闭）。
      const truncation = truncateHead(outputLines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes,
      });
      let output = truncation.content;
      const notices: string[] = [];

      if (matchLimitReached) {
        notices.push(
          effectiveLimit + " matches limit reached. Use headLimit=" + effectiveLimit * 2 + " for more, or refine pattern",
        );
      }
      if (truncation.truncated) {
        notices.push(formatSize(maxBytes) + " limit reached");
      }
      if (linesTruncated) {
        notices.push("Some lines truncated to " + GREP_MAX_LINE_LENGTH + " chars. Use read tool to see full lines");
      }
      if (notices.length > 0) {
        output += "\n\n[" + notices.join(". ") + "]";
      }

      return {
        path: searchPath,
        output,
        matchCount: totalMatches,
        filesScanned,
        ...(matchLimitReached ? { matchLimitReached } : {}),
        ...(linesTruncated ? { linesTruncated: true } : {}),
        ...(truncation.truncated ? { truncation } : {}),
      };
    },
  });
}
