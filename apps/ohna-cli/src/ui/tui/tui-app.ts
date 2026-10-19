/**
 * TuiApp：整屏 TUI 外壳（全屏 shell + 语义条目投影 + 输入编辑器 + 面板）。
 *
 * Phase C1b 的架构变化（相对 C1a 的追加式模型）：
 * - 不再持有 `contentLines / buffer`（预合成 ANSI 行）；改为持有 {@link TuiState}
 *   —— 语义条目 + verbosity + 展开状态，所有可见行由 `rows.projectRows` 纯投影产出；
 * - `append(text)` 仍是公共入口（repl 的 `write()` / 欢迎头 / slash 输出走它），但内部
 *   把文本转为 `notice` 条目（`meta.rawAnsi=true` 原样透传 ANSI），按 `\n` 固化；
 * - `attachStream(presenter)` 订阅 C1a 的 `PrintPresenter`；事件不再打印到 sink，而由同一归约流投影成整屏帧；
 * - ctrl+o 原地开关「最近一个折叠组」（不再向对话流追加全文）。
 *
 * Phase C2 的输入分派变化：
 * - `handleInput` 先经 {@link InputAssembler} 拼合跨 chunk 的完整序列，再交给 {@link InputRouter} 模式栈；
 * - editor 常驻底栈，picker / palette / file-palette 按压栈弹出；全局键（ctrl+o / Shift+Tab / Esc / Ctrl+C）
 *   由 router 统一裁决，editor 不再优先消费；confirm 是独占顶栈模式（权限卡激活时吞掉一切按键）。
 *
 * Phase C3 的合成槽（D8）：
 * - `askToolCall(info)` 打开 {@link PermissionCard} 并替换输入区；对话流不再出现权限问题文本；
 * - `toast(text)` 把瞬时提示推进 {@link TuiState.toasts}，`buildFrame` 在输入框上方渲染最多 1 条；
 * - 两者都在全帧重算里合成，不引入备用屏 / 浮层 / zIndex。
 *
 * 终端原语（raw mode / 光标 / 清屏）与节流幂等重绘由 `@aiagent/term` 提供；
 * resize 安全性完全由 `Screen` 保证，本类无需 resize 代码。
 *
 * Phase C4 的结构变化：帧组合（对话区 / 合成槽 / 面板 / 状态行 + 高度钳制）已抽到
 * `frame.ts` 的 {@link composeFrame} 纯函数；本类只做「取状态快照 → 组合 → 回写滚动预算」。
 */
import { RawTerminal, Screen } from "@aiagent/term";
import { isDoubleEscape } from "./esc-gesture.js";
import { paint } from "../theme.js";
import { LineEditor } from "./tui-editor.js";
import { FileReferencePalette } from "./tui-file-palette.js";
import { SessionPicker, type SessionPickerItem } from "./tui-session-picker.js";
import { TuiState, type TuiEntrySource } from "./state.js";
import { lastGroup } from "./rows.js";
import { scrollState } from "./transcript.js";
import {
  clampIndex,
  filteredCommands,
  handleFilePaletteKey,
  handlePanelKey,
  paletteActive,
  type TuiStatus,
} from "./panels.js";
import { InputRouter, type InputMode } from "./input-router.js";
import { InputAssembler } from "./input-assembler.js";
import type { PermissionCardDecision, PermissionCardInfo } from "./permission-card.js";
import { PermissionCardRequest } from "./permission-request.js";
import { composeFrame } from "./frame.js";
import type { ToastAction } from "./toast.js";
import type { TuiVerbosity } from "../stream/entries.js";

// 面板工具从 panels.ts 拆出；这里 re-export 保持既有公共入口与测试导入路径不变。
export { buildPalette, clampIndex } from "./panels.js";
export type { TuiStatus } from "./panels.js";
// C3：权限卡类型从本入口透出，供 repl 装配与单测引用。
export type { PermissionCardDecision, PermissionCardInfo } from "./permission-card.js";
export type { ToastAction } from "./toast.js";

/** TuiApp 的构造选项。 */
export interface TuiAppOptions {
  /** 输入框提示符（可带色）；缺省 `❯ `（user 色）。 */
  prompt?: string;
  /** 工作区根目录（`@` 文件候选面板的扫描基准）；缺省 process.cwd()。 */
  cwd?: string;
}

/**
 * 整屏 TUI 应用：持有 Screen、LineEditor、面板与 {@link TuiState}，
 * 提供整屏组合与生命周期。
 *
 * 上层（repl）通过 `setOutputSink(s => tui.append(s))` 把宿主输出接入 notice 流，
 * 通过 `attachStream(printPresenter)` 订阅事件归约结果，通过设置
 * `onSubmit` / `onInterrupt` 钩子接收用户输入与中断，通过 `askToolCall(info)`
 * 在 coding 模式确认闸门下开权限卡，通过 `toast(text)` 展示瞬时提示。
 */
export class TuiApp {
  /** 整屏渲染器（驱动 RawTerminal 做节流 + 幂等重绘）。 */
  private readonly screen: Screen;
  /** 精简输入编辑器。 */
  private readonly editor: LineEditor;
  /** `@` 文件候选面板（懒加载 workspace 文件）。 */
  private readonly filePalette: FileReferencePalette;
  /** `/resume` 会话选择面板（无参时展示最近会话）。 */
  private readonly sessionPicker = new SessionPicker();
  /** 投影状态：语义条目 + verbosity + 展开状态（唯一可变状态容器，D5）。 */
  private readonly state = new TuiState();
  /** 输入路由模式栈（Phase C2）。 */
  private readonly router: InputRouter;
  /** 跨 chunk 输入序列拼装器：未闭合转义序列缓冲 + 超时兜底（见 input-assembler.ts）。 */
  private readonly inputAssembler: InputAssembler;
  /** 底栈编辑器模式：所有未消费输入最终落到这里。 */
  private readonly editorMode: InputMode;
  /** 独占确认模式：权限卡激活时压栈（C3）。 */
  private readonly confirmMode: InputMode;
  /** `/` 命令面板模式（输入派生，随输入自动注册 / 注销）。 */
  private readonly paletteMode: InputMode;
  /** `/resume` 会话选择模式。 */
  private readonly sessionPickerMode: InputMode;
  /** `@` 文件候选模式。 */
  private readonly filePaletteMode: InputMode;
  /** 权限卡请求生命周期（C3）：Promise / abort / 结算收口见 {@link PermissionCardRequest}。 */
  private readonly cardRequest: PermissionCardRequest;

  /** `/` 命令面板的选中下标（面板关闭时无意义，见 {@link filteredCommands}）。 */
  private selectedIndex = 0;

  /** 状态行求值函数：返回 undefined 表示不显示状态行（如非 TTY / 未装配）。 */
  private statusFn?: () => TuiStatus | undefined;

  /** 上一次 Esc 时刻：用于识别「双击 Esc」手势（F-2，见 {@link handleEscape}）。 */
  private lastEscapeAt = 0;

  /** 最近一次 buildFrame 的终端宽度与对话区预算（C4 输入分派时复用）。 */
  private lastWidth = 80;
  private lastDialogueBudget = 0;

  /** 提交钩子：用户按 Enter（且非确认态）时以输入文本调用。 */
  onSubmit?: (value: string) => void;
  /** 中断钩子：用户按 Ctrl+C（且非确认态）时调用（上层决定中断 run 或退出）。 */
  onInterrupt?: () => void;
  /** Esc 中断钩子：用户按单次 Esc（且非确认态、非面板态）时调用；上层仅中断 run、空闲不退出（F-2）。 */
  onEscape?: () => void;
  /**
   * verbosity / 折叠切换钩子：用户按 Ctrl+O 时调用。
   *
   * C1b 起 ctrl+o 是「原地开关最近一个折叠组」：上层通常转调
   * {@link toggleLastGroup}；不再向对话流追加全文。
   */
  onVerboseToggle?: () => void;
  /** 权限模式循环钩子：用户按 Shift+Tab 时调用（上层循环 default → acceptEdits → plan）。 */
  onModeCycle?: () => void;
  /** 会话选择钩子：用户在 `/resume` 面板按 Enter 时以会话 id 调用（上层执行切换）。 */
  onSessionSelected?: (id: string) => void;

  /**
   * 构造整屏 TUI。
   *
   * @param options 可选提示符与工作目录。
   */
  constructor(options?: TuiAppOptions) {
    const terminal = new RawTerminal();
    this.screen = new Screen(terminal);
    const prompt = options?.prompt ?? paint("❯ ", "user");
    this.editor = new LineEditor({ prompt });
    this.filePalette = new FileReferencePalette({
      cwd: options?.cwd ?? process.cwd(),
      onUpdate: () => this.requestRender(),
    });

    this.editorMode = {
      id: "editor",
      handle: (data) => {
        this.editor.handleInput(data);
        return true;
      },
    };
    this.confirmMode = {
      id: "confirm",
      exclusive: true,
      handle: (data) => {
        // 独占：所有按键都交给权限卡（有裁决则结算并弹栈，否则仅移动选中）。
        this.cardRequest.handleKey(data);
        return true;
      },
    };
    this.paletteMode = {
      id: "palette",
      handle: (data) => {
        const result = handlePanelKey(
          {
            editor: this.editor,
            selectedIndex: this.selectedIndex,
            sessionPicker: this.sessionPicker,
            filePalette: this.filePalette,
          },
          data,
        );
        this.selectedIndex = result.selectedIndex;
        return result.consumed;
      },
      onExit: () => {
        this.editor.value = "";
        this.editor.cursor = 0;
        this.selectedIndex = 0;
        this.editor.onChange?.();
      },
    };
    this.sessionPickerMode = {
      id: "session-picker",
      handle: (data) => {
        const result = this.sessionPicker.handleKey(data);
        if (result.selectedId) this.onSessionSelected?.(result.selectedId);
        return result.consumed;
      },
      onExit: () => {
        // Esc / Ctrl+C 弹栈时必须真正关闭选择器，否则 syncModes 会立刻把它重新压栈。
        this.sessionPicker.close();
      },
    };
    this.filePaletteMode = {
      id: "file-palette",
      handle: (data) => handleFilePaletteKey(this.editor, this.filePalette, data),
      onExit: () => {
        // 让文件面板记住「被 Esc 关闭时的输入」，避免下一帧又自动弹出。
        this.filePalette.handleKey("\x1b", this.editor.value);
      },
    };

    this.router = new InputRouter({
      onVerbose: () => this.onVerboseToggle?.(),
      onModeCycle: () => this.onModeCycle?.(),
      onScrollUp: () => scrollState(this.state, { width: this.lastWidth, budget: this.lastDialogueBudget }, "up"),
      onScrollDown: () => scrollState(this.state, { width: this.lastWidth, budget: this.lastDialogueBudget }, "down"),
      onScrollBottom: () => scrollState(this.state, { width: this.lastWidth, budget: this.lastDialogueBudget }, "bottom"),
      onInterrupt: () => this.onInterrupt?.(),
      onEscape: () => this.handleEscape(),
    });
    this.router.push(this.editorMode);

    // 输入最上游：缓冲跨 chunk 未闭合转义序列；即时片段与超时兜底共用同一路由。
    this.inputAssembler = new InputAssembler({ onFlush: (sequence) => this.dispatchInput(sequence) });

    // 权限卡请求：开卡压 confirm 独占模式，结算弹栈并重绘（C3）。
    this.cardRequest = new PermissionCardRequest({
      onOpen: () => {
        this.router.remove("confirm");
        this.router.push(this.confirmMode);
        // M5：确认态冻结 toast 计时器，避免用户在决策期间被超时吞掉提示。
        this.state.toasts.pause();
      },
      onClose: () => {
        this.router.remove("confirm");
        this.state.toasts.resume();
      },
      onChange: () => this.requestRender(),
    });

    // 状态是唯一变更源：任何写入最终都汇聚到一次 requestRender。
    this.state.subscribe(() => this.requestRender());
  }

  /** 当前 verbosity（repl 的 `/verbose` 循环读取）。 */
  getVerbosity(): TuiVerbosity {
    return this.state.verbosity;
  }

  /**
   * 设置 verbosity 三档（TUI 投影语义，D6）。
   *
   * @param level 目标档位。
   */
  setVerbosity(level: TuiVerbosity): void {
    this.state.setVerbosity(level);
  }

  /**
   * 订阅事件归约流（C1a 的 `PrintPresenter`）。
   *
   * 事件仍由 presenter 归约与广播，但宿主应同时关闭 presenter 的事件打印
   * （`setEventRenderingEnabled(false)`），否则事件行会与投影重复。
   *
   * @param source 条目源（`entries()` + `subscribe()`；可选 `appendNotice`）。
   */
  attachStream(source: TuiEntrySource): void {
    this.state.attachSource(source);
  }

  /**
   * 设置状态行求值函数：`buildFrame` 每帧调用它求值（返回 undefined 则不显示状态行）。
   *
   * @param fn 求值函数，或 undefined 表示隐藏状态行。
   */
  setStatus(fn: (() => TuiStatus | undefined) | undefined): void {
    this.statusFn = fn;
  }

  /**
   * 打开 `/resume` 会话选择面板（输入框下方展示最近会话）。
   *
   * @param items 最近会话（调用方已按更新时间倒序）。
   */
  openSessionPicker(items: readonly SessionPickerItem[]): void {
    this.sessionPicker.openWith(items);
    this.syncModes();
    this.requestRender();
  }

  /**
   * 追加一段文本到对话流：按 `\n` 固化为 `notice` 条目（`rawAnsi` 原样透传）。
   *
   * @param text 来自 render 层的整块文本（可能含多行与 ANSI）。
   */
  append(text: string): void {
    this.state.appendNotice(text, { rawAnsi: true });
  }

  /**
   * 追加一条用户输入回显为 `user` 条目（M3：整屏 TUI 对话流的语义条目）。
   *
   * 与 `append`（notice + rawAnsi）的区别：这里存**未上色原文**，由投影层负责
   * `❯ ` 标记与 user 配色，因此用户输入与 assistant / tool 条目共享分组与滚动模型。
   *
   * @param text 用户输入原文（未上色）。
   */
  appendUser(text: string): void {
    this.state.appendUser(text);
  }

  /**
   * 会话级视图重置（M2）：清空展开状态、滚动归零并清空 toast。
   *
   * 会话切换（/clear、/resume、fork）时由 `repl-commands` 经 `onSessionSwitched` 调用，
   * 避免上一个会话的 `expanded` / 滚动位置 / 提示残留到新会话。
   */
  resetView(): void {
    this.state.resetView();
  }

  /**
   * 追加一条完整行（立即固化）。
   *
   * @param line 单行文本（可含 ANSI）。
   */
  appendLine(line: string): void {
    this.append(`${line}\n`);
  }

  /**
   * 原地开关「最近一个折叠组」的展开状态（ctrl+o 的新语义）。
   *
   * 不再向对话流追加全文：只改 `state.expanded`，下一帧由投影层重算。
   *
   * @returns 是否找到可折叠组（false 表示当前无可折叠组，调用方可提示用户）。
   */
  toggleLastGroup(): boolean {
    const last = lastGroup(this.state.entries(), this.state.verbosity, this.state.expanded);
    if (!last) return false;
    this.state.setExpanded(last.id, !last.expanded);
    return true;
  }

  /**
   * 推入一条瞬时提示（C3 · D8）：队列语义与 1 行渲染槽见 {@link ToastQueue}。
   *
   * 不经对话流，因此排队 / 模式切换 / 自动放行等提示不会污染历史。
   *
   * @param text 展示文本（可含 ANSI，调用方自行着色）。
   * @param options 可选时长与动作。
   */
  toast(text: string, options?: { duration?: number; action?: ToastAction }): void {
    this.state.toasts.push({ text, ...options });
  }

  /**
   * 打开权限卡并等待裁决（D7 结构化 ask 协议）。
   *
   * 卡片替换输入区（D8 合成槽），压 confirm 独占模式；`Esc` / `Ctrl+C` 都是显式拒绝，
   * `signal` 中断时按 null 收口——任何路径都保证 Promise 必定 resolve，不会悬挂。
   *
   * @param info 工具名 / 摘要 / 可选 diff 预览。
   * @param signal run 级中断信号（可选）。
   * @returns 用户裁决；null 表示被中断（闸门按拒绝处理）。
   */
  askToolCall(info: PermissionCardInfo, signal?: AbortSignal): Promise<PermissionCardDecision | null> {
    return this.cardRequest.ask(info, signal);
  }

  /**
   * 组合整屏帧：对话区（条目纯投影的尾部）→ 输入框 → 面板 → 状态行，全部按屏宽裁剪。
   *
   * 纯组合逻辑已抽到 {@link composeFrame}（`frame.ts`）；这里只负责取当前状态快照，
   * 并把「对话区预算」回写给滚动键复用（C4）。
   *
   * @param width 终端列数。
   * @param height 终端行数。
   * @returns 整屏每一行（已是带 ANSI 的最终文本，且无任何行可见宽超过 width）。
   */
  buildFrame(width: number, height: number): string[] {
    this.lastWidth = width;
    const frame = composeFrame({
      width,
      height,
      editor: this.editor,
      ...(this.cardRequest.current ? { card: this.cardRequest.current } : {}),
      ...(this.state.toasts.current ? { toast: this.state.toasts.current } : {}),
      pending: this.state.toasts.pending,
      sessionPicker: this.sessionPicker,
      filePalette: this.filePalette,
      selectedIndex: this.selectedIndex,
      entries: this.state.entries(),
      verbosity: this.state.verbosity,
      expanded: this.state.expanded,
      backfill: this.state.backfill,
      historyOffset: this.state.historyOffset,
      status: this.statusFn?.(),
    });
    this.lastDialogueBudget = frame.dialogueBudget;
    return frame.lines;
  }

  /**
   * 输入分发入口：先经 {@link InputAssembler} 拼装跨 chunk 的完整序列，再逐段路由；
   * 半截 `\x1b`（可能是 Esc，也可能是 CSI 前缀）由 assembler 缓冲后按超时兜底。
   *
   * @param data 原始 stdin 输入（可能是单键或一小段 chunk）。
   */
  private handleInput(data: string): void {
    for (const sequence of this.inputAssembler.feed(data)) this.dispatchInput(sequence);
  }

  /** @param data 已拼装完整的输入片段（即时序列与超时兜底共用）。 */
  private dispatchInput(data: string): void {
    // confirm（权限卡）独占期间不注册其它弹出模式，避免它们被压到确认模式之上。
    if (!this.cardRequest.active) this.syncModes();
    this.router.dispatch(data);
    if (!this.cardRequest.active) this.syncModes();
    this.selectedIndex = clampIndex(this.selectedIndex, filteredCommands(this.editor.value).length);
    this.requestRender();
  }

  /**
   * 按输入派生状态注册 / 注销弹出模式。
   *
   * 压栈顺序保证旧优先级：session-picker > palette > file-palette > editor。
   * 这里只是「模式生命周期」同步，不再承担按键优先级判断（那归 router）。
   */
  private syncModes(): void {
    this.router.setTransientMode("file-palette", this.filePalette.fragment(this.editor.value) !== null, this.filePaletteMode);
    this.router.setTransientMode("palette", paletteActive(this.editor.value), this.paletteMode);
    this.router.setTransientMode("session-picker", this.sessionPicker.isOpen(), this.sessionPickerMode);
  }

  /**
   * F-2：处理一次 Esc 按下（无弹出面板时）。
   *
   * 单次 Esc 立即触发中断；双击 Esc 识别为「编辑上一条输入」占位手势。
   * 确认态由独占 confirm 模式先行消费，不会走到这里。
   */
  private handleEscape(): void {
    const now = Date.now();
    if (isDoubleEscape(this.lastEscapeAt, now)) {
      this.lastEscapeAt = 0;
      this.appendLine(paint("» （回退编辑将在 checkpoint/rewind 落地后启用）", "dim"));
      return;
    }
    this.lastEscapeAt = now;
    this.onEscape?.();
  }

  /**
   * 启动整屏 TUI：接管终端、装配渲染与输入、注册编辑器回调、绘制首帧。
   */
  start(): void {
    process.stdout.write("\x1b[?25l");
    this.screen.setRenderFn((w, h) => this.buildFrame(w, h));
    this.screen.setOnInput((d) => this.handleInput(d));

    this.editor.onSubmit = (value) => {
      this.lastEscapeAt = 0;
      // confirm 模式的 Enter 已被 router 独占消费，这里只处理普通提交。
      this.onSubmit?.(value);
    };

    this.editor.onChange = () => this.requestRender();
    this.screen.start();
    this.requestRender();
  }

  /** 停止整屏 TUI：结算在途权限卡、释放 Toast 计时器、交还终端并恢复硬件光标。 */
  stop(): void {
    this.inputAssembler.dispose();
    this.cardRequest.dispose();
    this.state.toasts.dispose();
    this.screen.stop();
    process.stdout.write("\x1b[?25h");
  }

  /** 触发一次整屏重绘（委托 Screen 节流）。 */
  private requestRender(): void {
    this.screen.requestRender();
  }
}
