/**
 * find 工具：按 glob 模式查找文件/目录（只读，无任何写副作用）。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/find.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 移植改造：typebox → zod v4；剥离 pi-tui 渲染与 ExtensionContext；
 * 不依赖 fd 二进制（pi 用 ensureTool 下载），改为 Node 原生 readdir 递归 + 自实现 glob → 正则，
 * 保证零安装可跑；新增 assertPathWithinRoot / isDeniedPath 只读沙箱校验。
 */
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import { assertPathWithinRoot, isDeniedPath } from "../policy/path-policy.js";
import { pathExists, resolveToCwd } from "../support/path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../support/truncate.js";

/** 默认结果上限（超过提示放大 limit）。 */
const DEFAULT_LIMIT = 1000;

/** 默认递归深度上限，防止在巨型仓库里无界遍历。 */
const DEFAULT_MAX_DEPTH = 16;

/** 递归扫描时直接跳过的目录。 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "coverage"]);

/** 正则元字符集，用于 glob 里的字面量转义。 */
const REGEXP_META = /[.*+?^$|()[\]\\{}]/g;

/** find 工具入参 schema（description 用英文便于模型理解，补中文说明便于人读）。 */
export const findInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Glob pattern to match, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'。文件名/路径 glob 模式"),
  path: z.string().optional().describe("Directory to search in (default: current directory)。搜索根，默认工作目录"),
  maxDepth: z.number().int().min(0).optional().describe("Maximum recursion depth (default: 16)。最大递归深度"),
  type: z
    .enum(["file", "directory", "all"])
    .optional()
    .describe("Entry type to return: file (default), directory, or all。返回条目类型"),
  limit: z.number().int().min(1).optional().describe("Maximum number of results (default: 1000)。最多返回结果数"),
});

/** find 工具入参类型。 */
export type FindInput = z.infer<typeof findInputSchema>;

/** find 工具结构化输出（同时作为 details 回传）。 */
export interface FindOutput {
  /** 搜索根绝对路径。 */
  path: string;
  /** 已截断的结果文本，即回喂模型的内容。 */
  output: string;
  /** 命中结果的条数。 */
  resultCount: number;
  /** 命中结果上限时回传该上限值。 */
  resultLimitReached?: number;
  /** 命中字节上限时回传截断信息。 */
  truncation?: TruncationResult;
}

/** find 工具可选项。 */
export interface FindToolOptions {
  /** 覆盖默认字节上限（默认 DEFAULT_MAX_BYTES = 50KB）。 */
  maxBytes?: number;
}

/**
 * 转义正则元字符。
 *
 * @param value 原始字符串。
 * @returns 转义后可安全放进 RegExp 的字符串。
 */
function escapeRegExp(value: string): string {
  return value.replace(REGEXP_META, "\\$&");
}

/**
 * 校验搜索根是否允许遍历：必须落在工作目录内且不属于敏感路径。
 *
 * @param absolutePath 已解析的绝对路径。
 * @param cwd 工作目录（沙箱根）。
 * @throws 越界或命中敏感路径时抛出 code 为 permission_denied 的结构化错误。
 */
function assertSearchable(absolutePath: string, cwd: string): void {
  const withinRoot = assertPathWithinRoot(absolutePath, cwd);
  if (!withinRoot.ok) {
    throw Object.assign(new Error("Find denied: " + withinRoot.reason), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }

  if (isDeniedPath(absolutePath)) {
    throw Object.assign(new Error("Find denied: " + absolutePath + " is a sensitive path"), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }
}

/**
 * 把 glob 转成正则：** 跨目录、* 不跨目录、? 单字符，其余字符按字面量转义。
 *
 * @param glob glob 模式串。
 * @returns 用于全量匹配的正则。
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
 * 把路径分隔符统一成 posix 风格，保证输出跨平台稳定。
 *
 * @param value 路径字符串。
 * @returns 以 / 分隔的路径。
 */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * 递归查找匹配 glob 的条目；目录带 / 后缀，结果相对搜索根。
 *
 * 这里刻意**全量收集**而不在遍历中截断：遍历顺序由 readdir 决定，边遍历边截断会让
 * 返回的 N 条随文件系统顺序漂移，模型看到的结果不可复现。排序与截断交给调用方，
 * 保证「字典序前 N 条」的语义稳定（代价是命中极多时多占一点内存）。
 *
 * @param root 搜索根绝对路径。
 * @param matcher glob 对应的正则。
 * @param matchPath 是否按相对路径匹配（pattern 含 / 时）而非只比文件名。
 * @param wanted 需要的条目类型。
 * @param maxDepth 最大递归深度。
 * @param signal 取消信号。
 * @returns 命中的相对路径列表（未排序）。
 */
async function findEntries(
  root: string,
  matcher: RegExp,
  matchPath: boolean,
  wanted: "file" | "directory" | "all",
  maxDepth: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const entries: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Operation aborted"), { code: "cancelled" });
    }

    const current = stack.pop();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    const items = await fsReaddir(current.dir, { withFileTypes: true }).catch(() => []);

    for (const item of items) {
      const fullPath = path.join(current.dir, item.name);
      const relativePath = toPosix(path.relative(root, fullPath));
      const isDirectory = item.isDirectory();

      if (isDirectory) {
        if (SKIPPED_DIRECTORIES.has(item.name) || item.name.startsWith(".") || isDeniedPath(fullPath)) {
          continue;
        }
        if (wanted !== "file" && matcher.test(matchPath ? relativePath : item.name)) {
          entries.push(relativePath + "/");
        }
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!item.isFile() || isDeniedPath(fullPath)) continue;
      if (wanted === "directory") continue;
      if (!matcher.test(matchPath ? relativePath : item.name)) continue;

      entries.push(relativePath);
    }
  }

  return entries;
}

/**
 * 创建 find 工具：按 glob 模式查找文件（或目录），返回相对搜索根的路径。
 *
 * @param cwd 工作目录（同时是只读沙箱根）。
 * @param options 可选覆盖字节上限。
 * @returns 可直接注入注册表的 AgentTool。
 */
export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findInputSchema, FindOutput> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  return defineAgentTool({
    name: "find",
    description:
      "Find files and directories by glob pattern. Returns paths relative to the search directory, with a trailing / for directories. " +
      "Skips node_modules/.git/hidden directories. Output is truncated to " +
      DEFAULT_LIMIT +
      " results or " +
      Math.floor(maxBytes / 1024) +
      "KB (whichever is hit first).",
    label: "find",
    parameters: findInputSchema,
    effect: "read",
    source: "real",
    execution: { timeoutMs: 30_000, hasSideEffects: false, idempotent: true },
    formatResult: (output) => output.output,
    /**
     * 查找条目：解析路径 → 沙箱校验 → 递归匹配 → 排序 → 截断。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级取消信号，在目录边界检查。
     * @returns 结果文本与统计/截断信息。
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

      const searchStat = await fsStat(searchPath);
      if (!searchStat.isDirectory()) {
        throw Object.assign(new Error("Not a directory: " + searchPath), {
          code: "execution_error",
          details: { path: searchPath },
        });
      }

      let matcher: RegExp;
      try {
        matcher = globToRegExp(params.pattern);
      } catch (error) {
        throw Object.assign(new Error("Invalid pattern: " + (error as Error).message), {
          code: "validation_error",
          details: { pattern: params.pattern },
        });
      }

      const effectiveLimit = params.limit ?? DEFAULT_LIMIT;
      const allEntries = await findEntries(
        searchPath,
        matcher,
        params.pattern.includes("/"),
        params.type ?? "file",
        params.maxDepth ?? DEFAULT_MAX_DEPTH,
        signal,
      );

      // 先全局排序再截断，保证 limit 截断的是「字典序前 N 条」而不是遍历时恰好先遇到的那些。
      const sortedEntries = allEntries.sort();
      const entries = sortedEntries.slice(0, effectiveLimit);
      const limitReached = sortedEntries.length > effectiveLimit;

      if (entries.length === 0) {
        return { path: searchPath, output: "No files found matching pattern", resultCount: 0 };
      }

      const truncation = truncateHead(entries.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes,
      });
      let output = truncation.content;
      const notices: string[] = [];

      if (limitReached) {
        notices.push(effectiveLimit + " results limit reached. Use limit=" + effectiveLimit * 2 + " for more");
      }
      if (truncation.truncated) {
        notices.push(formatSize(maxBytes) + " limit reached");
      }
      if (notices.length > 0) {
        output += "\n\n[" + notices.join(". ") + "]";
      }

      return {
        path: searchPath,
        output,
        resultCount: entries.length,
        ...(limitReached ? { resultLimitReached: effectiveLimit } : {}),
        ...(truncation.truncated ? { truncation } : {}),
      };
    },
  });
}
