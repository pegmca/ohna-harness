/**
 * REPL 的整屏 TUI 装配：创建 TuiApp、注入状态行 / 输出 sink，并集中管理生命周期。
 *
 * 从 repl.ts 拆出的原因：REPL 已到单文件行数上限，而这一块只负责「把宿主输出接到
 * 整屏投影」的终端细节，不参与输入循环与会话状态机。拆出后 repl 只保留分支与调用，
 * TUI 的启停顺序（先接 sink 再打印欢迎头、先复位 sink 再停 Screen）仍由这里保证。
 *
 * 依赖方向：本模块只向下依赖 ui（TuiApp / render presenter），不反向 import repl。
 */
import type { ActiveModel } from "@aiagent/ai";
import type { PermissionPreset } from "@aiagent/agent";
import {
  printPresenter,
  setOutputSink,
  setSpinnerEnabled,
  type UsageTracker,
} from "../ui/render.js";
import { TuiApp } from "../ui/tui/tui-app.js";

/** 创建整屏 TUI 所需的会话依赖；全部用 getter 读取实时值。 */
export interface ReplTuiOptions {
  /** 工作区根目录（`@` 文件面板扫描基准）。 */
  cwd: string;
  /** 读取当前模型（`/model` 切换后状态行要立即反映）。 */
  getModel(): ActiveModel;
  /** 会话级用量累计器（状态行展示上下文占比）。 */
  tracker: UsageTracker;
  /** 读取当前权限预设（Shift+Tab 切换后状态行即时可见）。 */
  getPermissionPreset(): PermissionPreset;
}

/** TuiApp 的输入钩子：与 TuiApp 公共字段一一对应。 */
export interface ReplTuiHooks {
  /** 回车提交一行输入。 */
  onSubmit(value: string): void;
  /** Ctrl+C（非确认态）。 */
  onInterrupt(): void;
  /** 单次 Esc（非确认态 / 非面板态）。 */
  onEscape(): void;
  /** Ctrl+O：原地开关最近一个折叠组。 */
  onVerboseToggle(): void;
  /** Shift+Tab：权限模式循环。 */
  onModeCycle(): void;
}

/** 整屏 TUI 句柄：调用方只接触 tui 实例、启动与退出三个入口。 */
export interface ReplTuiHandle {
  /** 已装配输出 sink 与状态行的 TuiApp（权限闸门 / 命令分发直接使用）。 */
  readonly tui: TuiApp;
  /**
   * 挂载输入钩子并启动整屏渲染。
   *
   * @param hooks 提交 / 中断 / Esc / verbosity / 权限模式回调。
   */
  start(hooks: ReplTuiHooks): void;
  /** 复位输出 sink、停 Screen 并恢复 spinner（退出会话时调用一次）。 */
  dispose(): void;
}

/**
 * 创建并预装配整屏 TUI。
 *
 * 此时只注入输出通道与状态行，不启动终端接管；调用方先打印欢迎头，再调用
 * {@link ReplTuiHandle.start}，保证欢迎内容进入首帧。
 *
 * @param options 工作区、模型 / 用量 / 权限模式的实时读取器。
 * @returns 整屏 TUI 句柄。
 */
export function createReplTui(options: ReplTuiOptions): ReplTuiHandle {
  // 整屏 TUI：把 render 输出注入对话模型，并禁用 spinner（避免 \r\x1b[K 污染）。
  const tui = new TuiApp({ cwd: options.cwd });

  // 状态行：模型名 + 上下文占比（input / contextWindow）。两者都是闭包读取、每帧实时
  // 求值，因此 `/model` 切换与每轮 tracker 增长都会自动反映到输入框下方居右的状态行。
  tui.setStatus(() => {
    const model = options.getModel();
    return {
      model: model.model.id,
      contextPercent: Math.round(
        (options.tracker.snapshot().input / Math.max(1, model.model.contextWindow)) * 100,
      ),
      // 权限模式放状态行左侧（与右侧模型/占比同处输入框下方），Shift+Tab 切换即时可见。
      permissionMode: options.getPermissionPreset(),
    };
  });

  setOutputSink((s) => tui.append(s));
  setSpinnerEnabled(false);
  // C1b：事件不再打印到 sink，而是由同一归约流投影到整屏帧；notice 仍走 append。
  printPresenter.setEventRenderingEnabled(false);
  // C3：模型调用失败等瞬时提示改走 Toast（详情仍留在对话流 entry 上）。
  printPresenter.setNotifier((text) => tui.toast(text));
  tui.attachStream(printPresenter);

  return {
    tui,

    /**
     * 挂载输入钩子并启动整屏渲染。
     *
     * @param hooks 提交 / 中断 / Esc / verbosity / 权限模式回调。
     */
    start(hooks: ReplTuiHooks): void {
      // 提交/中断/Esc/verbose 切换/Shift+Tab 模式循环交给编辑器，启动后由 Screen 接管终端。
      tui.onSubmit = hooks.onSubmit;
      tui.onInterrupt = hooks.onInterrupt;
      tui.onEscape = hooks.onEscape;
      // ctrl+o：原地开关最近一个折叠组（C1b），不再向对话流追加全文。
      tui.onVerboseToggle = hooks.onVerboseToggle;
      tui.onModeCycle = hooks.onModeCycle;
      tui.start();
    },

    /** 复位输出 sink、停 Screen 并恢复 spinner（退出会话时调用一次）。 */
    dispose(): void {
      // 复位输出 sink（先复位，避免后续输出进对话模型）、停 Screen 还原终端、恢复 spinner。
      setOutputSink(undefined);
      printPresenter.setEventRenderingEnabled(true);
      printPresenter.setNotifier(undefined);
      tui.stop();
      setSpinnerEnabled(true);
    },
  };
}
