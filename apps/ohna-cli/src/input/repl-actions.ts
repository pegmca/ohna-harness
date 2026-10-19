/**
 * REPL 的 UI 动作：verbosity 循环、权限模式循环、折叠组切换、输入回显与确认闸门装配。
 *
 * 从 repl.ts 拆出的原因：这些动作只读写「终端表现」与权限会话，不参与 run 队列 /
 * history / 落盘等核心状态机。拆出后 repl 保持在线数上限内，且每个动作只依赖注入的
 * `tui` 与 `permissionSession`，不反向 import repl。
 *
 * 依赖方向：本模块向下依赖 permission / ui；调用方负责提供闭包，避免形成循环依赖。
 */
import type { Interface as ReadlineInterface } from "node:readline";
import { createToolConfirmGate, type ConfirmHook } from "../permission/confirm.js";
import type { PermissionSession } from "../permission/permission-session.js";
import { printPresenter, write, type TuiVerbosity } from "../ui/render.js";
import { inputBottomBar, paint, supportsAnsi } from "../ui/theme.js";
import type { TuiApp } from "../ui/tui/tui-app.js";

/** verbosity 循环顺序（D6）：low → medium → high → low。 */
const VERBOSITY_LEVELS: readonly TuiVerbosity[] = ["low", "medium", "high"];

/** UI 动作的构造依赖：TUI 只在整屏分支存在。 */
export interface ReplActionsOptions {
  /** 整屏 TUI；readline 分支为 undefined（提示改直写）。 */
  tui?: TuiApp;
  /** 跨轮权限会话（模式循环与 `/permissions` 共用同一状态）。 */
  permissionSession: PermissionSession;
}

/** REPL 使用的终端动作集合。 */
export interface ReplActions {
  /**
   * Shift+Tab：按 default → acceptEdits → plan → default 循环；TUI 下回显走 Toast（C3）。
   */
  cyclePermissionMode(): void;
  /**
   * 切换 verbosity 档位并回显：无参循环 low → medium → high，带参直达指定档。
   *
   * @param arg 可选 `low` / `medium` / `high`（`/verbose` 参数）。
   */
  cycleVerbosity(arg: string): void;
  /** ctrl+o 的 TUI 语义：原地开关最近一个折叠组（无分组时给 dim 提示）。 */
  toggleLastGroup(): void;
  /**
   * 回显一行「已排队」输入：TUI 同时写入对话区与 Toast，readline 直写。
   *
   * @param trimmed 已 trim 的输入文本。
   * @param index 入队序号（从 1 起）。
   */
  echoQueued(trimmed: string, index: number): void;
  /**
   * 回显一次成功提交的输入：TTY 下写入对话区 / 关闭输入框盒子。
   *
   * @param trimmed 已 trim 的输入文本。
   */
  echoSubmitted(trimmed: string): void;
}

/**
 * 创建 REPL 的 UI 动作集合。
 *
 * @param options TUI 实例与权限会话。
 * @returns 绑定到同一会话状态的终端动作。
 */
export function createReplActions(options: ReplActionsOptions): ReplActions {
  const { tui, permissionSession } = options;

  return {
    /** Shift+Tab：循环权限预设；TUI 下回显走 Toast（C3）。 */
    cyclePermissionMode(): void {
      const message = permissionSession.cycle();
      // TUI：模式切换是瞬时提示，走 Toast，不进对话流；非 TTY 保持原样直写。
      if (tui) tui.toast(paint(message.trimEnd(), "dim"));
      else write(message);
    },

    /**
     * 切换 verbosity 档位并回显。
     *
     * @param arg 可选 `low` / `medium` / `high`；其它值按循环推进。
     */
    cycleVerbosity(arg: string): void {
      const requested = arg.trim().toLowerCase();
      let next: TuiVerbosity;
      if (requested === "low" || requested === "medium" || requested === "high") {
        next = requested;
      } else {
        const current = tui ? tui.getVerbosity() : printPresenter.getVerbosity();
        next = VERBOSITY_LEVELS[(VERBOSITY_LEVELS.indexOf(current) + 1) % VERBOSITY_LEVELS.length];
      }
      printPresenter.setVerbosity(next);
      tui?.setVerbosity(next);
      // TUI：档位切换提示走 Toast（瞬时、不污染历史）；非 TTY 仍直写。
      if (tui) tui.toast(paint(`verbosity: ${next}`, "dim"));
      else write(paint(`verbosity: ${next}\n`, "dim"));
    },

    /** ctrl+o：原地开关最近一个折叠组；没有可折叠组时只给 dim 提示。 */
    toggleLastGroup(): void {
      if (tui) {
        if (!tui.toggleLastGroup()) tui.toast(paint("没有可折叠的分组", "dim"));
        return;
      }
      write(paint("没有可折叠的分组\n", "dim"));
    },

    /**
     * 回显一行「已排队」输入。
     *
     * @param trimmed 已 trim 的输入文本。
     * @param index 入队序号（从 1 起）。
     */
    echoQueued(trimmed: string, index: number): void {
      if (tui) {
        tui.appendUser(trimmed);
        // C3：排队提示是瞬时状态，走 Toast；非 TTY 仍直写。
        tui.toast(paint(`» 已排队（#${index}）`, "dim"));
      } else {
        write(`» 已排队（#${index}）\n`);
      }
    },

    /**
     * 回显一次成功提交的输入。
     *
     * @param trimmed 已 trim 的输入文本。
     */
    echoSubmitted(trimmed: string): void {
      // 提交：TTY 下把用户输入回显进对话区（user 语义条目）；readline 下打印输入框下边框闭合盒子。
      if (!supportsAnsi()) return;
      if (tui) tui.appendUser(trimmed);
      else write(paint(inputBottomBar(process.stdout.columns || 80), "dim"));
    },
  };
}

/** 确认闸门的装配依赖：TUI 与 readline 二选一。 */
export interface ReplToolGateOptions {
  /** --yes：闸门初始按 bypass 处理（策略仍可由 getPreset 覆盖）。 */
  autoApprove: boolean;
  /** 工作区根目录（权限摘要里的相对路径）。 */
  cwd: string;
  /** 跨轮权限会话（PolicyState + 实时 preset）。 */
  permissionSession: PermissionSession;
  /** 整屏 TUI：走结构化权限卡与 Toast。 */
  tui?: TuiApp;
  /** readline 分支：复用主 readline 做三选项问答。 */
  readline?: ReadlineInterface;
}

/**
 * 装配 beforeToolCall 权限闸门。
 *
 * TTY 整屏用 tui.confirm 收集三选项，否则复用主 readline；两条路径共享同一个
 * PermissionSession，因此 Shift+Tab / `/permissions mode` 对下一次工具调用立即生效。
 *
 * @param options 自动放行开关、工作区、权限会话与输入通道。
 * @returns 可直接交给 runTurn 的确认钩子。
 */
export function createReplToolGate(options: ReplToolGateOptions): ConfirmHook {
  return createToolConfirmGate({
    autoApprove: options.autoApprove,
    cwd: options.cwd,
    state: options.permissionSession.state,
    getPreset: () => options.permissionSession.preset(),
    ...(options.tui
      ? {
          askToolCall: (info, signal) => options.tui!.askToolCall(info, signal),
          notify: (text: string) => options.tui!.toast(text),
        }
      : { readline: options.readline! }),
  });
}
