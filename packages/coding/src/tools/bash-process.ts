/**
 * bash 子进程原语：shell 解析、进程树 kill、退出等待、输出清洗。
 * 这些是与「工具语义」无关的一层，单独成文件以便 bash-executor.ts 只保留编排逻辑。
 *
 * ported from pi (badlogic/packages/coding-agent)，MIT License，Copyright (c) 2025 Mario Zechner：
 * - src/utils/shell.ts 的 getShellConfig / killProcessTree / sanitizeBinaryOutput
 * - src/utils/child-process.ts 的 waitForChildProcess
 *
 * 改造点：剥离 cross-spawn、detached pid 全局追踪表与 pi 的二进制探测逻辑，
 * 只保留 aiagent 需要的最小集合。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/** 进程退出后，等待 stdio 静默的宽限时间；期间每来一块数据就重新计时。 */
const EXIT_STDIO_GRACE_MS = 100;

/** ANSI 转义序列（OSC / CSI，含 8 位 CSI 形式），用于把彩色输出清洗成纯文本。 */
const ANSI_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|\u001B\[[0-9;:?]*[ -\/]*[@-~]|\u009B[0-9;:?]*[ -\/]*[@-~]/g;

/** 子进程解析出的 shell 配置。 */
export interface ShellConfig {
  /** shell 可执行文件绝对路径。 */
  shell: string;
  /** 传给 shell 的固定参数（不含待执行命令）。 */
  args: string[];
  /** 命令传递方式：argv 走命令行参数，stdin 走标准输入。 */
  transport: "argv" | "stdin";
}

/**
 * 解析 shell 配置：显式路径优先，其次 process.env.SHELL，最后回退 /bin/bash。
 * Windows 回退到 cmd.exe（/d /s /c）；不支持交互式 stdin 注入。
 *
 * @param shellPath 可选的显式 shell 路径。
 * @returns shell 配置。
 * @throws shellPath 指向的文件不存在时抛 code 为 execution_error 的错误。
 */
export function resolveShellConfig(shellPath?: string): ShellConfig {
  if (shellPath) {
    if (!existsSync(shellPath)) {
      throw Object.assign(new Error("Shell path does not exist: " + shellPath), { code: "execution_error" });
    }
    return { shell: shellPath, args: ["-c"], transport: "argv" };
  }

  if (process.platform === "win32") {
    return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"], transport: "argv" };
  }

  return { shell: process.env.SHELL ?? "/bin/bash", args: ["-c"], transport: "argv" };
}

/**
 * kill 进程树：POSIX 下先按进程组 kill（子进程以 detached 启动，自成一组），
 * 失败再回退 kill 单个 pid；Windows 用 taskkill /T。kill 失败一律忽略 —— 进程可能已退出。
 *
 * @param pid 子进程 pid，同时也是 POSIX 下的进程组 id。
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      // 进程已退出或 taskkill 不可用，忽略
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出，忽略
    }
  }
}

/**
 * 等待子进程结束，同时不让「被子进程继承的 stdio 句柄」把等待挂死。
 *
 * 只等 close 会被 detached 后代进程持有的管道拖住；只等 exit 又可能截断仍在写入的尾部输出。
 * 折中：exit 后等两条管道都 end，并挂一个宽限定时器，期间每来一块数据就重新计时 ——
 * 仍在输出的后代进程会持续续期，安静的继承句柄则在宽限到期后释放我们。
 *
 * @param child 已 spawn 的子进程。
 * @returns 退出码；被信号杀死时为 null。
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let idleTimer: NodeJS.Timeout | undefined;

    /** 清理全部监听与定时器。 */
    const cleanup = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    /** 结束等待并销毁两条管道，防止句柄泄漏。 */
    const finalize = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    /** 重新挂载宽限定时器，用于观察 stdio 是否已静默。 */
    const armIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    /** stdio 数据回调：退出后仍来数据则续期，避免截断尾部输出。 */
    const onData = (): void => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };

    /** stdout 结束回调。 */
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      if (exited && stderrEnded) {
        finalize(exitCode);
      }
    };

    /** stderr 结束回调。 */
    const onStderrEnd = (): void => {
      stderrEnded = true;
      if (exited && stdoutEnded) {
        finalize(exitCode);
      }
    };

    /** 子进程错误回调（如 shell 不可执行）。 */
    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    /** 子进程退出回调。 */
    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      if (stdoutEnded && stderrEnded) {
        finalize(code);
        return;
      }
      armIdleTimer();
    };

    /** 子进程 close 回调（所有 stdio 关闭）。 */
    const onClose = (code: number | null): void => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * 把子进程输出清洗成可安全回喂模型的文本：去 ANSI 转义、控制字符与格式字符。
 * 二进制输出（如误 cat 一个可执行文件）常带这些字符，直接回喂会污染模型上下文。
 *
 * @param text 解码后的原始输出。
 * @returns 清洗后的文本。
 */
export function sanitizeText(text: string): string {
  const stripped = text.replace(ANSI_PATTERN, "").replace(/\r/g, "");
  let result = "";
  for (const char of stripped) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += char;
      continue;
    }
    if (code <= 0x1f) {
      continue;
    }
    // 单独出现的代理项与 Unicode 格式字符会让字符串宽度计算崩溃，直接丢弃。
    if ((code >= 0xd800 && code <= 0xdfff) || (code >= 0xfff9 && code <= 0xfffb)) {
      continue;
    }
    result += char;
  }
  return result;
}
