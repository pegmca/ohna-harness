/**
 * bash 编排层：把「一条命令」翻译成一次受控的子进程执行，并负责收尾与错误定型。
 * 进程原语（shell 解析 / kill 进程树 / 退出等待 / 输出清洗）在 ./bash-process.ts。
 *
 * ported from pi (badlogic/packages/coding-agent)，MIT License，Copyright (c) 2025 Mario Zechner：
 * - src/core/tools/bash.ts 的 createLocalBashOperations
 * - src/core/bash-executor.ts 的 executeBashWithOperations
 *
 * 改造点：剥离 pi-tui / theme / extension context 与 detached pid 全局追踪表；
 * 超时、取消、spawn 失败统一抛带 code 的结构化 Error，交由 packages/tools 的包装层转换。
 *
 * 设计取舍：stdout 与 stderr 分别监听两条管道（分别统计字节数），但按到达顺序写入
 * 同一个 OutputAccumulator —— 与 pi 一致，避免两条流被拆成两段后丢失真实交错顺序。
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

import { OutputAccumulator } from "../support/output-accumulator.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../support/truncate.js";
import { killProcessTree, resolveShellConfig, sanitizeText, waitForChildProcess } from "./bash-process.js";

/** bash 工具默认超时：60 秒。 */
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

/** setTimeout 可用的最大毫秒数（再大就会溢出成立即触发）。 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** 临时文件前缀，便于在 /tmp 中识别来源。 */
const TEMP_FILE_PREFIX = "aiagent-bash";

/** executeBash 的执行选项。 */
export interface ExecuteBashOptions {
  /** 子进程工作目录（绝对路径）。 */
  cwd: string;
  /** 超时毫秒数；不传表示本层不主动 kill，由外层 withTimeoutAndRetry 兜底。 */
  timeoutMs?: number;
  /** run 级取消信号；abort 时 kill 整个进程树。 */
  signal?: AbortSignal;
  /** 子进程环境变量；缺省继承 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 自定义 shell 路径；缺省 process.env.SHELL，再缺省 /bin/bash。 */
  shellPath?: string;
  /** 输出字节上限；缺省 DEFAULT_MAX_BYTES。 */
  maxBytes?: number;
  /** 输出行数上限；缺省 DEFAULT_MAX_LINES。 */
  maxLines?: number;
  /** 可选的流式输出回调（已清洗 ANSI 与控制字符）。 */
  onChunk?: (chunk: string) => void;
}

/** 一次命令执行的完整结果。 */
export interface BashExecutionResult {
  /** 截断后的输出文本；为空时由调用方补占位文案。 */
  output: string;
  /** 进程退出码；被 kill 时为 null。 */
  exitCode: number | null;
  /** 是否被取消信号中止。 */
  cancelled: boolean;
  /** 是否因超时被 kill。 */
  timedOut: boolean;
  /** 输出是否被截断（超出字节或行数上限）。 */
  truncated: boolean;
  /** 截断明细，供 trace/UI 展示；未截断时为空。 */
  truncation?: TruncationResult;
  /** 完整输出落盘的临时文件路径（仅截断时存在）。 */
  fullOutputPath?: string;
  /** stdout 原始字节数。 */
  stdoutBytes: number;
  /** stderr 原始字节数。 */
  stderrBytes: number;
}

/**
 * 在指定工作目录下执行一条 shell 命令并收集输出。
 *
 * 超时与取消都会 kill 整个进程树（POSIX 下按进程组 kill，避免孤儿进程继续写输出）；
 * 输出超过上限时只回传尾部，并把完整输出写入临时文件。
 *
 * @param command 待执行的 shell 命令。
 * @param options 执行选项（cwd / 超时 / 信号 / env / shell / 输出上限）。
 * @returns 命令执行结果（含退出码与截断信息）。
 * @throws 超时抛 code 为 timeout 的错误；被取消抛 code 为 cancelled；工作目录或 shell 不可用抛 code 为 execution_error。
 */
export async function executeBash(command: string, options: ExecuteBashOptions): Promise<BashExecutionResult> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const shell = resolveShellConfig(options.shellPath);
  await assertDirectoryExists(options.cwd);

  const output = new OutputAccumulator({
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
    tempFilePrefix: TEMP_FILE_PREFIX,
  });

  const decoder = new TextDecoder();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let cancelled = false;

  const child = spawn(shell.shell, shell.transport === "stdin" ? shell.args : [...shell.args, command], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    // stdin 传输时才开管道，否则忽略，避免子进程读到宿主 stdin（本工具不做交互式输入）。
    stdio: [shell.transport === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    // POSIX 下独立进程组，kill 时可以整组 kill；Windows 无进程组概念。
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  /**
   * 把字节块写入累加器并按需回调流式输出。
   *
   * @param data 原始字节块。
   */
  const handleOutputChunk = (data: Buffer): void => {
    output.append(data);
    if (options.onChunk) {
      options.onChunk(sanitizeText(decoder.decode(data, { stream: true })));
    }
  };

  /**
   * 处理一块 stdout 输出：先统计字节数，再交给累加器。
   *
   * @param data 原始字节块。
   */
  const handleStdout = (data: Buffer): void => {
    stdoutBytes += data.length;
    handleOutputChunk(data);
  };

  /**
   * 处理一块 stderr 输出：与 stdout 共用累加器，保证交错顺序不丢。
   *
   * @param data 原始字节块。
   */
  const handleStderr = (data: Buffer): void => {
    stderrBytes += data.length;
    handleOutputChunk(data);
  };

  /** kill 子进程所在进程树（pid 存在时）。 */
  const killTree = (): void => {
    if (child.pid !== undefined) {
      killProcessTree(child.pid);
    }
  };

  /** 取消信号回调：标记 cancelled 并 kill 进程树。 */
  const onAbort = (): void => {
    cancelled = true;
    killTree();
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  child.stdout?.on("data", handleStdout);
  child.stderr?.on("data", handleStderr);
  if (shell.transport === "stdin") {
    child.stdin?.on("error", () => {});
    child.stdin?.end(command);
  }

  let result: BashExecutionResult | undefined;
  try {
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }

    const exitCode = await waitForChildProcess(child);
    result = await finalizeOutput(output, { exitCode, timedOut, cancelled, stdoutBytes, stderrBytes });
  } catch (error) {
    // 底层异常（如 shell 不可执行）：先关掉临时文件句柄，再转成结构化错误抛出。
    await output.closeTempFile();
    throw toExecutionError(error);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (result.cancelled) {
    throw Object.assign(new Error(withStatus(result, "Command aborted")), {
      code: "cancelled",
      details: result,
    });
  }

  if (result.timedOut && timeoutMs !== undefined) {
    const message = withStatus(result, "Command timed out after " + timeoutMs / 1000 + " seconds");
    throw Object.assign(new Error(message), { code: "timeout", details: result });
  }

  return result;
}

/**
 * 收尾输出：补齐流式解码尾块、按需落临时文件、关闭句柄，并拼装回传文本与截断提示。
 *
 * @param output 输出累加器。
 * @param state 退出码与执行状态。
 * @returns 命令执行结果。
 */
async function finalizeOutput(
  output: OutputAccumulator,
  state: {
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
    stdoutBytes: number;
    stderrBytes: number;
  },
): Promise<BashExecutionResult> {
  output.finish();
  const snapshot = output.snapshot({ persistIfTruncated: true });
  await output.closeTempFile();

  const truncation = snapshot.truncation;
  let text = snapshot.content;
  if (truncation.truncated) {
    text += "\n\n[" + formatTruncationNotice(truncation, snapshot.fullOutputPath, output.getLastLineBytes()) + "]";
  }

  return {
    output: text,
    exitCode: state.exitCode,
    cancelled: state.cancelled,
    timedOut: state.timedOut,
    truncated: truncation.truncated,
    truncation: truncation.truncated ? truncation : undefined,
    fullOutputPath: snapshot.fullOutputPath,
    stdoutBytes: state.stdoutBytes,
    stderrBytes: state.stderrBytes,
  };
}

/**
 * 把未知异常转成带 code 的结构化 Error，避免把底层堆栈直接泄漏给上层。
 *
 * @param error 捕获到的未知异常。
 * @returns 带 code 的 Error。
 */
function toExecutionError(error: unknown): Error {
  if (error instanceof Error) {
    return Object.assign(error, { code: "execution_error" });
  }
  return Object.assign(new Error(String(error)), { code: "execution_error" });
}

/**
 * 把结局说明追加到输出文本之后（pi 的 appendStatus 语义），
 * 保证模型同时看到「已产生的输出」与「失败原因」。
 *
 * @param result 命令执行结果。
 * @param status 结局说明（如超时、被取消、退出码）。
 * @returns 拼接后的文本。
 */
export function withStatus(result: BashExecutionResult, status: string): string {
  return result.output ? result.output + "\n\n" + status : status;
}

/**
 * 校验并规范超时毫秒数；非法值抛结构化错误，避免 setTimeout 溢出成立即触发。
 *
 * @param timeoutMs 调用方给出的超时毫秒数。
 * @returns 规范后的毫秒数；undefined 表示本层不限制。
 */
function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new Error("Invalid timeout: must be a finite positive number of milliseconds"), {
      code: "validation_error",
    });
  }

  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

/**
 * 确认工作目录存在且可访问；不存在时抛结构化错误，避免 spawn 抛出裸异常。
 *
 * @param cwd 待校验的目录。
 */
async function assertDirectoryExists(cwd: string): Promise<void> {
  try {
    await access(cwd, constants.F_OK);
  } catch {
    throw Object.assign(new Error("Working directory does not exist: " + cwd), { code: "execution_error" });
  }
}

/**
 * 生成输出截断提示，明确告知模型「看到了哪一部分、完整输出在哪」。
 *
 * @param truncation 截断明细。
 * @param fullOutputPath 完整输出临时文件路径。
 * @param lastLineBytes 末行字节数（用于 lastLinePartial 提示）。
 * @returns 提示文本。
 */
function formatTruncationNotice(
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
  lastLineBytes: number,
): string {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;

  if (truncation.lastLinePartial) {
    return (
      "Showing last " +
      formatSize(truncation.outputBytes) +
      " of line " +
      endLine +
      " (line is " +
      formatSize(lastLineBytes) +
      "). Full output: " +
      fullOutputPath
    );
  }

  if (truncation.truncatedBy === "lines") {
    return "Showing lines " + startLine + "-" + endLine + " of " + truncation.totalLines + ". Full output: " + fullOutputPath;
  }

  return (
    "Showing lines " +
    startLine +
    "-" +
    endLine +
    " of " +
    truncation.totalLines +
    " (" +
    formatSize(DEFAULT_MAX_BYTES) +
    " limit). Full output: " +
    fullOutputPath
  );
}
