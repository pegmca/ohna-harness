/**
 * 渲染层公共入口（Phase C1 后退化为 **re-export / 薄委托壳**）。
 *
 * 为什么保留这个文件：`input/repl.ts` / `runtime/turn.ts` / `commands/*` / `cli/web-entry.ts`
 * 历史上都从 `ui/render.ts` 引入渲染与用量符号。C1 把实现迁到 `ui/stream/`（单一归约器
 * `StreamReducer` + 打印 presenter `PrintPresenter`）后，本文件只维持既有公共符号与签名，
 * 使调用方零修改或最少修改（v1.4 计划 D4：允许直接替换内部实现，不留旧实现兼容层）。
 * 这里的函数都是**一行委托**，不持有任何状态（D5）。
 *
 * 分层：
 * - `ui/stream/entries.ts`：语义条目契约（唯一事实源）；
 * - `ui/stream/reducer.ts`：AgentEvent → entry 的单一归约器；
 * - `ui/stream/print-format.ts`：折叠 / diff / 入参摘要等纯函数；
 * - `ui/stream/print.ts`：非 TTY 打印 presenter（原 render.ts + spinner.ts 的状态收编地）；
 * - `ui/spinner.ts`：只剩帧常量与纯函数（无模块级可变状态）。
 *
 * 已移除（D4）：`reprintRecentFolded` / `resetFoldCache`——折叠全文缓存随 ctrl+o
 * 「重打全文」语义一起删除，会话切换改为调用 `resetPresentation()`。
 */
import type { AgentEvent } from "@aiagent/agent";
import type { UsageTracker } from "../session/usage.js";
import type { TuiVerbosity } from "./stream/entries.js";
import { printPresenter } from "./stream/print.js";
import type { RenderOptions } from "./stream/print-format.js";

export { PrintPresenter, printPresenter } from "./stream/print.js";
export { foldOutput, renderToolDiff } from "./stream/print-format.js";
export type { RenderOptions } from "./stream/print-format.js";
export type {
  TuiEntry,
  TuiEntryKind,
  TuiEntryStatus,
  TuiEntryMeta,
  TuiVerbosity,
} from "./stream/entries.js";
export type { StreamChange } from "./stream/reducer.js";
export { StreamReducer } from "./stream/reducer.js";

// 用量的累计 / 展示已拆到 usage.ts（会话级状态与事件渲染的职责分离）；
// 这里保留 re-export，使既有调用方（repl / harness / web-entry / session-flow）零修改。
export { createUsageTracker, formatCostLine } from "../session/usage.js";
export type { UsageSnapshot, UsageTracker } from "../session/usage.js";

/**
 * 渲染单个 AgentEvent（公共入口，内部委托默认 presenter）。
 *
 * @param event 来自 agentLoop 的事件。
 * @param tracker 会话级用量累计器。
 * @param options 渲染选项。
 */
export function renderEvent(event: AgentEvent, tracker: UsageTracker, options?: RenderOptions): void {
  printPresenter.renderEvent(event, tracker, options);
}

/**
 * 统一输出出口（render 层所有写入经此转发，便于 TTY 整屏模式注入 sink）。
 *
 * @param text 待输出文本。
 */
export function write(text: string): void {
  printPresenter.write(text);
}

/**
 * 设置输出 sink（注入式）；undefined 复位为直写 stdout。
 *
 * @param fn 新 sink 或 undefined。
 */
export function setOutputSink(fn: ((s: string) => void) | undefined): void {
  printPresenter.setOutputSink(fn);
}

/**
 * 设置宿主瞬时提示通道（C3）：TUI 接 Toast；非 TTY 不接。
 *
 * @param fn 提示回调；undefined 表示关闭。
 */
export function setNotifier(fn: ((text: string) => void) | undefined): void {
  printPresenter.setNotifier(fn);
}

/**
 * 设置 verbosity 三档（D6）。
 *
 * @param level 目标档位。
 */
export function setVerbosity(level: TuiVerbosity): void {
  printPresenter.setVerbosity(level);
}

/**
 * 读取当前 verbosity。
 *
 * @returns 当前档位。
 */
export function getVerbosity(): TuiVerbosity {
  return printPresenter.getVerbosity();
}

/**
 * 兼容入口：布尔 verbose → verbosity 三档（true=high，false=low）。
 *
 * @param value 旧语义的 verbose 开关。
 */
export function setVerbose(value: boolean): void {
  printPresenter.setVerbosity(value ? "high" : "low");
}

/**
 * 读取旧语义的 verbose 状态（仅 high 视为开启；medium 不在打印路径使用）。
 *
 * @returns 当前是否为 high 档。
 */
export function isVerbose(): boolean {
  return printPresenter.getVerbosity() === "high";
}

/** 会话级重置（/clear、/resume、fork）：清空 entry 与打印布局状态。 */
export function resetPresentation(): void {
  printPresenter.resetPresentation();
}

/**
 * 启用 / 禁用 spinner（TTY 整屏模式禁用）。
 *
 * @param value true 启用、false 禁用。
 */
export function setSpinnerEnabled(value: boolean): void {
  printPresenter.setSpinnerEnabled(value);
}

/**
 * 读取 spinner 是否启用。
 *
 * @returns spinner 是否启用。
 */
export function isSpinnerEnabled(): boolean {
  return printPresenter.isSpinnerEnabled();
}

/** 挂起 spinner（confirm 询问前，避免帧覆盖提示）。 */
export function suspendSpinner(): void {
  printPresenter.suspendSpinner();
}

/** 恢复 spinner（confirm resolve 后，按原动词重启）。 */
export function resumeSpinner(): void {
  printPresenter.resumeSpinner();
}
