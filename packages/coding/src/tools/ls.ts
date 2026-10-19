/**
 * ls 工具：列出目录内容（只读，无任何写副作用）。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/ls.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 移植改造：typebox → zod v4；剥离 pi-tui 渲染与 ExtensionContext；
 * 新增 assertPathWithinRoot / isDeniedPath 只读沙箱校验；隐藏文件改为可开关（默认不显示）。
 */
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { z } from "zod";
import { assertPathWithinRoot, isDeniedPath } from "../policy/path-policy.js";
import { pathExists, resolveToCwd } from "../support/path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../support/truncate.js";

/** 默认条目上限，超过后提示放大 limit 继续列。 */
const DEFAULT_LIMIT = 500;

/** ls 工具入参 schema（description 用英文便于模型理解，补中文说明便于人读）。 */
export const lsInputSchema = z.object({
  path: z.string().optional().describe("Directory to list (default: current directory)。待列目录，默认工作目录"),
  limit: z.number().int().min(1).optional().describe(`Maximum number of entries to return (default: ${DEFAULT_LIMIT})。最多返回条目数`),
  showHidden: z
    .boolean()
    .optional()
    .describe("Include dotfiles/dot-directories (default: false)。是否显示隐藏文件"),
});

/** ls 工具入参类型。 */
export type LsInput = z.infer<typeof lsInputSchema>;

/** ls 工具结构化输出（同时作为 details 回传）。 */
export interface LsOutput {
  /** 列出的目录绝对路径。 */
  path: string;
  /** 已截断的目录清单文本。 */
  output: string;
  /** 命中条目上限时回传该上限值。 */
  entryLimitReached?: number;
  /** 命中字节上限时回传截断信息。 */
  truncation?: TruncationResult;
}

/** ls 工具可选项。 */
export interface LsToolOptions {
  /** 覆盖默认条目上限。 */
  limit?: number;
  /** 覆盖默认字节上限（默认 DEFAULT_MAX_BYTES = 50KB）。 */
  maxBytes?: number;
}

/**
 * 校验目录是否允许列出：必须落在工作目录内且不属于敏感路径。
 *
 * @param absolutePath 已解析的绝对路径。
 * @param cwd 工作目录（沙箱根）。
 * @throws 越界或命中敏感路径时抛出 code 为 permission_denied 的结构化错误。
 */
function assertListable(absolutePath: string, cwd: string): void {
  const withinRoot = assertPathWithinRoot(absolutePath, cwd);
  if (!withinRoot.ok) {
    throw Object.assign(new Error(`List denied: ${withinRoot.reason}`), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }

  if (isDeniedPath(absolutePath)) {
    throw Object.assign(new Error(`List denied: ${absolutePath} is a sensitive path`), {
      code: "permission_denied",
      details: { path: absolutePath },
    });
  }
}

/**
 * 创建 ls 工具：列目录，目录名带 `/` 后缀，结果按名称大小写无关排序。
 *
 * @param cwd 工作目录（同时是只读沙箱根）。
 * @param options 可选覆盖条目/字节上限。
 * @returns 可直接注入注册表的 AgentTool。
 */
export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsInputSchema, LsOutput> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  return defineAgentTool({
    name: "ls",
    description:
      `List directory contents. Entries are sorted alphabetically (case-insensitive) with a "/" suffix for directories. ` +
      `Dotfiles are hidden unless showHidden is true. Output is truncated to ${Math.floor(maxBytes / 1024)}KB.`,
    label: "ls",
    parameters: lsInputSchema,
    effect: "read",
    source: "real",
    execution: { timeoutMs: 15_000, hasSideEffects: false, idempotent: true },
    formatResult: (output) => output.output,
    /**
     * 列目录：解析路径 → 沙箱校验 → 存在性与目录校验 → 过滤/排序 → 截断。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级取消信号，在进入和逐条 stat 前检查，保证取消可见。
     * @returns 目录清单文本与截断信息。
     */
    async execute(params, signal) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) {
          throw Object.assign(new Error("Operation aborted"), { code: "cancelled" });
        }
      };

      throwIfAborted();
      const dirPath = resolveToCwd(params.path || ".", cwd);
      assertListable(dirPath, cwd);

      if (!(await pathExists(dirPath))) {
        throw Object.assign(new Error(`Path not found: ${dirPath}`), {
          code: "execution_error",
          details: { path: dirPath },
        });
      }

      const stat = await fsStat(dirPath);
      if (!stat.isDirectory()) {
        throw Object.assign(new Error(`Not a directory: ${dirPath}`), {
          code: "execution_error",
          details: { path: dirPath },
        });
      }

      throwIfAborted();
      const entries = await fsReaddir(dirPath);
      const showHidden = params.showHidden ?? false;
      const visible = showHidden ? entries : entries.filter((entry) => !entry.startsWith("."));
      visible.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const effectiveLimit = params.limit ?? options?.limit ?? DEFAULT_LIMIT;
      const results: string[] = [];
      let entryLimitReached: number | undefined;

      for (const entry of visible) {
        throwIfAborted();
        if (results.length >= effectiveLimit) {
          entryLimitReached = effectiveLimit;
          break;
        }

        const fullPath = path.join(dirPath, entry);
        try {
          const entryStat = await fsStat(fullPath);
          results.push(entryStat.isDirectory() ? `${entry}/` : entry);
        } catch {
          // stat 失败的条目（如断链）直接跳过，不中断整体列目录。
          continue;
        }
      }

      if (results.length === 0) {
        return { path: dirPath, output: "(empty directory)" };
      }

      // 条目数已被 limit 约束，这里只保留字节上限（行数上限传 MAX_SAFE_INTEGER 关闭）。
      const truncation = truncateHead(results.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes,
      });
      let output = truncation.content;

      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(maxBytes)} limit reached`);
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        path: dirPath,
        output,
        ...(entryLimitReached ? { entryLimitReached } : {}),
        ...(truncation.truncated ? { truncation } : {}),
      };
    },
  });
}
