/**
 * 写/执行确认闸门：以 AgentLoopConfig.beforeToolCall 的形式挂在组合根上。
 *
 * 为什么放在这里而不是工具内部：权限是「组合根策略」——工具只提供能力，
 * 换 CLI / 换 API 时整套审批策略可整体替换；这也是 packages/agent 明确不接审批逻辑的原因。
 *
 * readline 边界（关键）：REPL 在 run 期间把主 readline pause 掉了。
 * 这里优先复用调用方传入的主 readline 实例调用 question——question 会隐式 resume，
 * 且在回调 pending 期间输入只交给 question，不会触发主循环的 'line' 事件（避免抢输入）；
 * 回答后必须重新 pause，恢复 run 期间的暂停语义。
 */
import * as path from "node:path";
import * as readline from "node:readline";
import type { BeforeToolCallContext, BeforeToolCallResult } from "@aiagent/agent";
import { write } from "./render.js";
import { resumeSpinner, suspendSpinner } from "./spinner.js";
import { CROSS, DOT, paint } from "./theme.js";

/** 需要人工确认的高风险工具：写文件、改文件、执行命令；只读工具直接放行。 */
const CONFIRM_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

/** 终端单行展示的最大长度，避免超长命令/路径刷屏。 */
const MAX_DISPLAY_LENGTH = 160;

/** 确认钩子的签名（与 AgentLoopConfig.beforeToolCall 一致）。 */
export type ConfirmHook = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/** 确认闸门的构造参数。 */
export interface ToolConfirmGateOptions {
  /** true 表示 --yes：跳过所有确认直接放行，适用于批处理与非交互场景。 */
  autoApprove: boolean;
  /** 工作区根目录，用于把绝对路径渲染成相对路径。 */
  cwd: string;
  /** REPL 的主 readline 实例；缺省（单次模式）时临时创建一个并在回答后关闭。 */
  readline?: readline.Interface;
  /**
   * TTY 整屏模式下的确认读取器：替代 readline 提问 y/n（TUI 下无 readline）。
   * 接收已着色的提问文本，返回用户输入原文，null 表示被中断（Ctrl-C）。
   */
  confirm?: (question: string) => Promise<string | null>;
}

/**
 * 创建写/执行确认闸门。
 *
 * @param options 是否自动放行、工作区根目录、可复用的 readline 实例。
 * @returns 可直接赋给 AgentLoopConfig.beforeToolCall 的钩子。
 */
export function createToolConfirmGate(options: ToolConfirmGateOptions): ConfirmHook {
  return async (context, signal): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    if (!CONFIRM_TOOL_NAMES.has(toolName)) return undefined;

    const summary = describeToolCall(toolName, context.args, options.cwd);

    if (options.autoApprove) {
      // 走 write()：整屏模式下放行提示会进对话模型，直写 stdout 会被下一帧清屏抹掉。
      write(paint(`${DOT} --yes 自动放行：${summary}`, "dim") + "\n");
      return undefined;
    }

    // 非交互环境（无 TTY）无法取得确认，默认拒绝而不是无限等待输入。
    if (!process.stdin.isTTY) {
      process.stdout.write(paint(`${CROSS} 已拒绝 ${summary}：非交互环境未传 --yes，默认拒绝写与执行。`, "error") + "\n");
      return { block: true, reason: `非交互环境且未传 --yes，已拒绝：${summary}` };
    }

    const question = paint(`? 是否允许 ${summary}？(y/N) `, "warn");
    const answer = options.confirm
      ? await askConfirmationVia(options.confirm, question, signal)
      : await askConfirmation(options.readline, question, signal);
    if (answer === null) {
      return { block: true, reason: `用户中断（Ctrl-C），已取消：${summary}` };
    }
    return /^y(es)?$/i.test(answer.trim()) ? undefined : { block: true, reason: `用户拒绝执行：${summary}` };
  };
}

/**
 * 把工具调用渲染成一句可读的中文摘要（工具名 + 目标路径或命令）。
 *
 * @param toolName 工具名。
 * @param args 通过 zod 校验后的工具入参。
 * @param cwd 工作区根目录。
 * @returns 一行摘要文本。
 */
function describeToolCall(toolName: string, args: unknown, cwd: string): string {
  const record = isRecord(args) ? args : {};

  if (toolName === "bash") {
    const command = typeof record.command === "string" ? record.command : String(args);
    return `bash 执行命令：${truncate(command.replace(/\s+/g, " "))}`;
  }

  const target = typeof record.path === "string" ? displayPath(record.path, cwd) : truncate(shortJson(args));
  if (toolName === "write") return `write 写入文件：${target}`;
  if (toolName === "edit") return `edit 编辑文件：${target}`;
  return `${toolName}：${target}`;
}

/**
 * 用 readline 问一个 y/n 问题，并与 run 的 AbortSignal 竞争：
 * Ctrl-C 中断当前 run 时立即返回 null（按拒绝处理），避免闸门悬挂导致 run 无法结束。
 *
 * @param rl 可复用的主 readline 实例；缺省时临时创建（回答后关闭）。
 * @param question 提示文案。
 * @param signal run 级中断信号。
 * @returns 用户输入原文；null 表示被中断（AbortSignal 触发）。
 */
async function askConfirmation(
  rl: readline.Interface | undefined,
  question: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const owned = rl === undefined;
  const iface = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  const abort = waitAbort(signal);

  try {
    // 挂起 spinner（单写者协议）：question 提示挂在输入行，spinner 帧若仍在跑会覆盖它。
    suspendSpinner();
    // question 期间输入只交给回调，不会触发主循环的 'line'，因此不会与 REPL 抢输入。
    const answer = await Promise.race([
      new Promise<string | null>((resolve) => {
        iface.question(question, resolve);
      }),
      abort.promise,
    ]);

    if (answer === null) {
      // 中断后 readline 仍挂着这次 question 的回调，若不冲刷掉，用户的下一行输入会被它吞掉。
      // 写入一个空行把回调消费掉，保证 Ctrl-C 之后 REPL 仍能正常读输入。
      iface.write("\n");
    }
    return answer;
  } finally {
    // 确认结束按需重启 spinner（仅当此前确实在跑，resumeSpinner 内部判断）。
    resumeSpinner();
    abort.dispose();
    // question 会隐式 resume：恢复 run 期间的 paused 状态，避免残留输入被主循环误读。
    if (owned) {
      iface.close();
    } else {
      iface.pause();
    }
  }
}

/**
 * 用 TUI 确认读取器问一个 y/n 问题，并与 run 的 AbortSignal 竞争：
 * TTY 整屏模式下无 readline，由 TuiApp.confirm 在对话框下方收集单行输入。
 *
 * @param confirm TUI 确认读取器（接收已着色提问，返回输入原文或 null）。
 * @param question 已着色的提示文案。
 * @param signal run 级中断信号。
 * @returns 用户输入原文；null 表示被中断（AbortSignal 触发或 Ctrl-C）。
 */
async function askConfirmationVia(
  confirm: (question: string) => Promise<string | null>,
  question: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const abort = waitAbort(signal);
  try {
    // 挂起 spinner（单写者协议）：确认期间不画帧。
    suspendSpinner();
    const answer = await Promise.race([confirm(question), abort.promise]);
    return answer;
  } finally {
    resumeSpinner();
    abort.dispose();
  }
}

/**
 * 构造「等待中断」的竞速分支：无 signal 时返回一个永不 resolve 的 Promise（交由用户输入决定）。
 *
 * @param signal run 级中断信号。
 * @returns promise 在中断时 resolve 为 null；dispose 用于摘除监听。
 */
function waitAbort(signal: AbortSignal | undefined): { promise: Promise<string | null>; dispose: () => void } {
  if (!signal) return { promise: new Promise<string | null>(() => {}), dispose: () => {} };

  let onAbort: (() => void) | undefined;
  const promise = new Promise<string | null>((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * 路径展示：工作区内渲染成相对路径，越界则保留绝对路径（越界本身会被工具层拒绝）。
 *
 * @param target 工具入参中的路径（绝对或相对）。
 * @param cwd 工作区根目录。
 * @returns 截断后的一行路径文本。
 */
function displayPath(target: string, cwd: string): string {
  const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  const shown = relative && !relative.startsWith("..") ? relative : absolute;
  return truncate(shown);
}

/**
 * 单行截断，超长用省略号收尾。
 *
 * @param text 原始文本。
 * @returns 不超过 MAX_DISPLAY_LENGTH 的文本。
 */
function truncate(text: string): string {
  return text.length > MAX_DISPLAY_LENGTH ? `${text.slice(0, MAX_DISPLAY_LENGTH)}…` : text;
}

/**
 * 入参的紧凑 JSON 兜底展示（结构意外时仍能给出可读信息）。
 *
 * @param value 工具入参。
 * @returns 紧凑字符串。
 */
function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 类型守卫：判断入参是否为对象记录。
 *
 * @param value 任意值。
 * @returns true 表示为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
