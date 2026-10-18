/**
 * bash 工具：在会话工作目录下执行 shell 命令。
 *
 * 这是 M1 里唯一会产生外部副作用的编码能力，因此护栏放在最前面：
 * 1. 先过命令策略（assessCommand，denylist 命中即拒绝，绝不执行）；
 * 2. 子进程固定以构造时传入的 cwd 为工作目录，命令内 cd 只影响本次子进程；
 * 3. 输出按「行数 / 字节」双上限头尾截断，超限时把完整输出落临时文件、只回传路径；
 * 4. 非 0 退出码以结构化错误抛出，且错误文本里带上已产生的输出，便于模型自愈。
 *
 * ported from pi (badlogic/packages/coding-agent/src/core/tools/bash.ts)，MIT License，
 * Copyright (c) 2025 Mario Zechner。
 * 移植改造：typebox → zod v4；剥离 pi-tui / theme / keybinding-hints 渲染与 ExtensionContext；
 * 危险命令判定抽到 ../policy/command-policy.js，工具层只负责执行与报错。
 */
import { z } from "zod";
import { defineAgentTool } from "@aiagent/tools";
import type { AgentTool } from "@aiagent/tools";
import { assessCommand } from "../policy/command-policy.js";
import { resolveToCwd } from "../support/path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../support/truncate.js";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  executeBash,
  withStatus,
  type BashExecutionResult,
} from "./bash-executor.js";

/** 单次命令允许的秒数上限（与 setTimeout 的最大毫秒数对齐）。 */
const MAX_TIMEOUT_SECONDS = Math.floor(MAX_TIMEOUT_MS / 1000);

/** bash 工具入参 schema（description 用英文便于模型理解，补中文便于人读）。 */
export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1, "command is required")
    .describe("Bash command to execute in the working directory. 待执行的 shell 命令，不得越出工作目录"),
  timeout: z
    .number()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      "Optional timeout in seconds (default: 60, capped by the tool default)。单次超时秒数，默认 60 秒",
    ),
});

/** bash 工具入参类型。 */
export type BashInput = z.infer<typeof bashInputSchema>;

/** bash 工具结构化输出（同时作为 details 回传给 trace / UI）。 */
export interface BashOutput extends BashExecutionResult {
  /** 实际执行的命令。 */
  command: string;
  /** 命令执行时的工作目录。 */
  cwd: string;
  /** 执行耗时（毫秒）。 */
  durationMs: number;
}

/** bash 工具可选项。 */
export interface BashToolOptions {
  /** 覆盖默认单次超时（毫秒，缺省 60000）。 */
  defaultTimeoutMs?: number;
  /** 覆盖默认输出字节上限（缺省 DEFAULT_MAX_BYTES）。 */
  maxBytes?: number;
  /** 覆盖默认输出行数上限（缺省 DEFAULT_MAX_LINES）。 */
  maxLines?: number;
  /** 自定义 shell 可执行文件路径（缺省 process.env.SHELL 或 /bin/bash）。 */
  shellPath?: string;
  /** 追加到子进程的环境变量（其余继承 process.env）。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 把模型给出的秒数换算成毫秒；缺省用工具默认超时，非法值抛结构化错误。
 *
 * @param timeoutSeconds 模型给出的超时秒数。
 * @param fallbackMs 工具默认超时毫秒数，同时充当单次超时上限。
 * @returns 生效的超时毫秒数。
 * @throws 秒数非法时抛出 code 为 validation_error 的错误。
 */
function resolveTimeoutMs(timeoutSeconds: number | undefined, fallbackMs: number): number {
  if (timeoutSeconds === undefined) {
    return fallbackMs;
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw Object.assign(new Error("Invalid timeout: must be a finite positive number of seconds"), {
      code: "validation_error",
    });
  }

  // 上限取工具声明的默认超时：外层 withTimeoutAndRetry 用的是同一个值，
  // 若允许单次超过它，包装层会先于命令自身超时，反而丢掉有意义的报错。
  return Math.min(Math.floor(timeoutSeconds * 1000), fallbackMs);
}

/**
 * 创建 bash 工具实例。
 *
 * @param cwd 会话工作目录；命令固定在该目录下执行，相对路径按其解析。
 * @param options 超时与输出上限等可选项。
 * @returns 可直接注入 AgentContext.tools 的 AgentTool。
 */
export function createBashTool(cwd: string, options: BashToolOptions = {}): AgentTool<typeof bashInputSchema, BashOutput> {
  // 工作目录在构造时固定：模型在命令里 cd 只影响本次子进程，不会改变后续工具调用的根。
  const workDir = resolveToCwd(cwd, process.cwd());
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

  return defineAgentTool<typeof bashInputSchema, BashOutput>({
    name: "bash",
    label: "Bash",
    description:
      "Execute a bash command in the working directory and return its combined stdout/stderr. " +
      "Output is truncated to the last " +
      DEFAULT_MAX_LINES +
      " lines or " +
      formatSize(DEFAULT_MAX_BYTES) +
      " (whichever is hit first); when truncated, the full output is saved to a temp file and only its path is reported. " +
      "Dangerous commands (rm -rf /, sudo, curl | sh, forced git pushes, writes outside the working directory) are rejected without running. " +
      "在会话工作目录下执行命令，默认超时 60 秒，可用 timeout 参数调整。",
    parameters: bashInputSchema,
    source: "real",
    // 命令有真实副作用：声明 hasSideEffects 后包装层不会自动重试（防重复执行）。
    // 这里的 timeoutMs 同时是单次超时的默认值与上限，kill 由 executeBash 执行。
    execution: { hasSideEffects: true, timeoutMs: defaultTimeoutMs },
    /**
     * 把执行结果序列化成回喂模型的文本；空输出保留占位说明，避免模型误以为命令没跑。
     *
     * @param output 命令执行结果。
     * @returns 回喂模型的文本。
     */
    formatResult: (output) => output.output || "(no output)",
    /**
     * 执行一条命令：策略拦截 → 子进程执行 → 非 0 退出码转结构化错误。
     *
     * @param params 已通过 zod 校验的入参。
     * @param signal run 级 AbortSignal，透传给子进程用于 kill。
     * @returns 结构化输出。
     */
    async execute(params, signal) {
      const command = params.command;
      const verdict = assessCommand(command, workDir);
      if (!verdict.allowed) {
        throw Object.assign(new Error("Command blocked by policy: " + verdict.reason), {
          code: "permission_denied",
          details: { command, cwd: workDir, reason: verdict.reason },
        });
      }

      const timeoutMs = resolveTimeoutMs(params.timeout, defaultTimeoutMs);
      const startedAt = Date.now();
      const result = await executeBash(command, {
        cwd: workDir,
        timeoutMs,
        signal,
        env: options.env,
        shellPath: options.shellPath,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
      });

      const output: BashOutput = { ...result, command, cwd: workDir, durationMs: Date.now() - startedAt };
      if (result.exitCode !== null && result.exitCode !== 0) {
        // 与 pi 一致：失败时把「已产生的输出 + 退出码」一起回喂，模型才能据此修。
        throw Object.assign(new Error(withStatus(result, "Command exited with code " + result.exitCode)), {
          code: "execution_error",
          details: output,
        });
      }

      return output;
    },
  });
}
