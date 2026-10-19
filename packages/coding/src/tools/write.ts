/**
 * write 工具：整文件写入（不存在则创建，存在则覆盖），自动创建父目录。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/write.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 改动点：
 * - 剥离 pi-tui 的语法高亮渲染与 extension 体系，工具只回文本与结构化 details；
 * - typebox schema → zod（与 packages/tools 的 defineAgentTool 对齐）；
 * - 新增写入前置策略校验（必须在 cwd 内、不得命中敏感文件 denylist），越界抛
 *   code="permission_denied"，由包装层转成结构化错误而不泄漏原始异常。
 */
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { isDeniedPath, assertPathWithinRoot } from "../policy/path-policy.js";
import { withFileMutationQueue } from "../support/file-mutation-queue.js";
import { resolveToCwd } from "../support/path-utils.js";

/** 写文件的默认超时；写盘通常很快，但大文件与网络盘可能超过 executor 默认的 10s。 */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

/** write 工具入参 schema。 */
export const writeInputSchema = z.object({
  path: z.string().min(1, "path is required").describe("Path to the file to write (relative to cwd or absolute)"),
  content: z
    .string()
    .describe("Full content to write to the file. Creates the file if missing, overwrites if it exists.")
});

/** write 工具的结构化输出（同时作为 details 供 CLI / trace 使用）。 */
export interface WriteToolOutput {
  /** 调用方传入的原始路径 */
  path: string;
  /** 解析后的绝对路径 */
  absolutePath: string;
  /** 写入内容的字符数（UTF-16 code units，与 pi 的 content.length 语义一致） */
  charCount: number;
  /** 写入内容的 UTF-8 字节数 */
  bytes: number;
}

export type WriteToolInput = z.infer<typeof writeInputSchema>;

/**
 * 可插拔的文件写入操作，默认走本地文件系统。
 * 抽出来的目的是让调用方（或测试）可以把写入委派到远端（如 SSH / 容器）实现。
 */
export interface WriteOperations {
  /** 把内容写入指定绝对路径 */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** 递归创建目录 */
  mkdir: (dir: string) => Promise<void>;
}

/** write 工具的可选项。 */
export interface WriteToolOptions {
  /** 自定义文件写入操作；默认本地文件系统 */
  operations?: WriteOperations;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  }
};

/**
 * 校验写入目标路径是否被允许：必须落在 root 目录内，且不能命中敏感文件 denylist。
 * 写类工具必须在「任何 fs 副作用之前」调用，避免拒绝前已经建出目录。
 *
 * @param absolutePath 解析后的绝对路径。
 * @param root 允许写入的根目录（即工具绑定的 cwd）。
 * @throws 越界或命中 denylist 时抛出 code="permission_denied" 的 Error。
 */
function assertWritablePath(absolutePath: string, root: string): void {
  if (isDeniedPath(absolutePath)) {
    throw Object.assign(new Error(`Writing to ${absolutePath} is denied: the path is a sensitive or generated location.`), {
      code: "permission_denied"
    });
  }

  const withinRoot = assertPathWithinRoot(absolutePath, root);
  if (!withinRoot.ok) {
    throw Object.assign(new Error(`Writing to ${absolutePath} is denied: ${withinRoot.reason}`), {
      code: "permission_denied"
    });
  }
}

/**
 * 创建写文件工具。
 *
 * @param cwd 工作目录：相对路径按它解析，同时也是允许写入的根目录。
 * @param options 可选自定义 fs 操作。
 * @returns 可直接注册进工具表的 AgentTool。
 */
export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeInputSchema, WriteToolOutput> {
  const ops = options?.operations ?? defaultWriteOperations;

  return defineAgentTool<typeof writeInputSchema, WriteToolOutput>({
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
      "Automatically creates parent directories. Use write only for new files or complete rewrites; " +
      "use edit for precise changes to an existing file.",
    parameters: writeInputSchema,
    // 写文件有副作用：进入权限策略（default 需确认，acceptEdits 放行，plan 拒绝）。
    effect: "mutate",
    // 写操作不可重试：重试可能重复落盘或覆盖并发写入的结果。
    execution: { hasSideEffects: true, timeoutMs: DEFAULT_WRITE_TIMEOUT_MS },
    source: "real",
    formatResult: (output) =>
      `Successfully wrote ${output.bytes} bytes (${output.charCount} chars) to ${output.path}` +
      `\nabsolute path: ${output.absolutePath}`,
    /**
     * 执行整文件写入：路径解析 → 策略校验 → 队列串行化 → mkdir -p → 落盘。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级取消信号。
     * @returns 写入字节数与解析后的路径信息。
     */
    async execute(params, signal) {
      const { path, content } = params;
      const absolutePath = resolveToCwd(path, cwd);
      assertWritablePath(absolutePath, cwd);

      const dir = dirname(absolutePath);

      return withFileMutationQueue(absolutePath, async () => {
        // 这里不在 abort 事件里直接 reject：那会在 fs 操作尚未 settled 时释放队列锁。
        // 改为在每个 await 之后检查 signal.aborted，取消可见性一致但队列保持锁定。
        const throwIfAborted = (): void => {
          if (signal?.aborted) {
            throw Object.assign(new Error("Operation aborted"), { code: "cancelled" });
          }
        };

        throwIfAborted();
        await ops.mkdir(dir);
        throwIfAborted();
        await ops.writeFile(absolutePath, content);
        throwIfAborted();

        return {
          path,
          absolutePath,
          charCount: content.length,
          bytes: Buffer.byteLength(content, "utf-8")
        };
      });
    }
  });
}
