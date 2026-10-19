/**
 * TuiApp：封装整屏 TUI（全屏 shell + 输入编辑器 + 追加式对话区）。
 *
 * 架构要点：
 * - 终端原语由 `@aiagent/term` 的 `RawTerminal` 提供（raw mode + bracketed paste +
 *   resize 监听）；整屏重绘由 `Screen` 负责——它用「节流 + 幂等全量重绘」根治
 *   readline 滚动输出在 resize 时无法安全重绘引发的「风暴」：连续 resize 只触发一次
 *   节流重绘，且每次都先清屏再画当前帧，永不残留/错位。
 * - 对话内容模型 `contentLines`：追加式，每项已是「含 ANSI 的最终行」，由 render 层
 *   经 `setOutputSink(s => tui.append(s))` 注入；流式 delta 以「开放行」`buffer` 累积，
 *   遇 `\n` 固化为一行。Phase B2 的「流式原地刷新」不在本阶段范围。
 * - 输入区用 `box([editor.render(...)], {title:"ohna"})` 包成边框，始终贴底。
 *
 * resize 安全性完全由 Screen 保证（已建好的节流 + 幂等），本类无需任何 resize 代码。
 */
import { RawTerminal, Screen, box, truncateToWidth, visibleWidth } from "@aiagent/term";
import { isDoubleEscape, splitLeadingEscapes } from "./esc-gesture.js";
import { paint, type ThemeRole } from "../theme.js";
import { LineEditor } from "./tui-editor.js";
import { FileReferencePalette } from "./tui-file-palette.js";
import { SessionPicker, type SessionPickerItem } from "./tui-session-picker.js";
import { filterSlashCommands, type SlashCommandDef } from "../../commands/slash.js";

/** 命令面板最多显示的条目数（与 SLASH_COMMANDS 规模一致，当前 12 条全部可见）。 */
export const MAX_PALETTE_ITEMS = 12;

/**
 * 把过滤后的命令渲染成 `/` 面板行：`  /cmd        描述`，选中行整行 reverse video 高亮。
 *
 * 纯函数（不依赖 TuiApp 状态），便于单测；不在此处做宽度裁剪——裁剪由调用方按终端
 * 列数统一 `truncateToWidth` 兜底。
 *
 * @param commands 已过滤的命令列表（保持顺序）。
 * @param selectedIndex 选中下标（调用方需已夹紧到 [0, len)）。
 * @returns 最多 {@link MAX_PALETTE_ITEMS} 行的面板文本（可能含 ANSI 反色高亮）。
 */
export function buildPalette(
  commands: readonly SlashCommandDef[],
  selectedIndex: number,
): string[] {
  const shown = commands.slice(0, MAX_PALETTE_ITEMS);
  if (shown.length === 0) return [];
  const nameWidth = Math.max(...shown.map((c) => c.name.length));
  return shown.map((c, i) => {
    const label = `  ${c.name.padEnd(nameWidth)}  ${c.description}`;
    return i === selectedIndex ? `\x1b[7m${label}\x1b[27m` : label;
  });
}

/**
 * 把选中下标夹紧到 `[0, length-1]`（过滤结果变化后调用，防止越界）。
 *
 * @param index 当前选中下标。
 * @param length 过滤结果条数。
 * @returns 夹紧后的下标；length <= 0 时返回 0。
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/**
 * 权限模式对应的语义色：default 低调、acceptEdits 强调、plan 警示、bypass 危险。
 *
 * @param mode 权限模式名。
 * @returns 主题色位；未知模式回退 dim。
 */
function permissionModeRole(mode: string): ThemeRole {
  switch (mode) {
    case "acceptEdits":
      return "accent";
    case "plan":
      return "warn";
    case "bypass":
      return "error";
    default:
      return "dim";
  }
}

/** TuiApp 的构造选项。 */
export interface TuiAppOptions {
  /** 输入框提示符（可带色）；缺省 `❯ `（user 色）。 */
  prompt?: string;
  /** 工作区根目录（`@` 文件候选面板的扫描基准）；缺省 process.cwd()。 */
  cwd?: string;
}

/**
 * 状态行内容：输入框下方居右展示的一行「模型 + 上下文占比」。
 *
 * 由上层（repl）通过 `setStatus` 注入一个求值函数，`buildFrame` 每帧调用它以实时
 * 反映最新的模型（`/model` 切换）与上下文占比（tracker 随每轮增长）。
 */
export interface TuiStatus {
  /** 模型名（如 hy3-x）。 */
  model: string;
  /** 上下文占比（0..100 的百分比）；负值 / 超界由 {@link TuiApp} 侧夹紧。 */
  contextPercent: number;
  /**
   * 当前权限模式（default / acceptEdits / plan / bypass），状态行左侧展示。
   *
   * 缺省按 `default` 渲染，保证未接权限会话的宿主（测试 / 旧装配）仍有稳定布局。
   */
  permissionMode?: string;
}

/**
 * 整屏 TUI 应用：持有 Screen 与 LineEditor，维护对话内容模型并提供整屏组合与生命周期。
 *
 * 上层（repl）通过 `setOutputSink(s => tui.append(s))` 把 render 输出接入对话模型，
 * 通过设置 `onSubmit` / `onInterrupt` 钩子接收用户输入与中断，通过 `confirm()` 在
 * coding 模式确认闸门下提问 y/n。
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
  /** 对话内容：已固化的「含 ANSI 最终行」，追加式增长。 */
  private contentLines: string[] = [];
  /** 当前未结束的开放行：流式 delta 累积于此，遇 `\n` 固化为 contentLines 一项。 */
  private buffer = "";
  /** 进行中的确认解析器：存在时编辑器提交/中断改走确认语义。 */
  private confirmResolver?: (value: string | null) => void;

  /** `/` 命令面板的选中下标（面板关闭时无意义，见 {@link filteredCommands}）。 */
  private selectedIndex = 0;

  /** 状态行求值函数：返回 undefined 表示不显示状态行（如非 TTY / 未装配）。 */
  private statusFn?: () => TuiStatus | undefined;

  /** 上一次 Esc 时刻：用于识别「双击 Esc」手势（F-2，见 {@link handleEscape}）。 */
  private lastEscapeAt = 0;

  /** 提交钩子：用户按 Enter（且非确认态）时以输入文本调用。 */
  onSubmit?: (value: string) => void;
  /** 中断钩子：用户按 Ctrl+C（且非确认态）时调用（上层决定中断 run 或退出）。 */
  onInterrupt?: () => void;
  /** Esc 中断钩子：用户按单次 Esc（且非确认态、非面板态）时调用；上层仅中断 run、空闲不退出（F-2）。 */
  onEscape?: () => void;
  /** verbose 切换钩子：用户按 Ctrl+O 时调用（上层切换开关并重打折叠块全文）。 */
  onVerboseToggle?: () => void;
  /** 权限模式循环钩子：用户按 Shift+Tab 时调用（上层循环 default → acceptEdits → plan）。 */
  onModeCycle?: () => void;
  /** 会话选择钩子：用户在 `/resume` 面板按 Enter 时以会话 id 调用（上层执行切换）。 */
  onSessionSelected?: (id: string) => void;

  /**
   * 构造整屏 TUI。
   *
   * @param options 可选提示符。
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
  }
  /**
   * 设置状态行求值函数：`buildFrame` 每帧调用它求值（返回 undefined 则不显示状态行）。
   *
   * 无需在此触发重绘——repl 装配完即 `start()` 画首帧，后续每帧都实时求值；
   * `/model` 切换与每轮 run 结束都会触发一次重绘，状态行随之更新。
   *
   * @param fn 求值函数，或 undefined 表示隐藏状态行。
   */
  setStatus(fn: (() => TuiStatus | undefined) | undefined): void {
    this.statusFn = fn;
  }

  /**
   * 打开 `/resume` 会话选择面板（输入框下方展示最近会话）。
   *
   * 由 repl 的 `/resume` handler 在取到 `store.list()` 结果后调用；面板打开期间
   * `handleInput` 优先把 ↑/↓/Enter/Esc 交给选择器，其余按键关闭面板并交回编辑器。
   *
   * @param items 最近会话（调用方已按更新时间倒序）。
   */
  openSessionPicker(items: readonly SessionPickerItem[]): void {
    this.sessionPicker.openWith(items);
    this.requestRender();
  }

  /**
   * 追加一段文本到对话模型：按 `\n` 拆分成固化行，末段作为开放行保留（流式累积）。
   *
   * @param text 来自 render 层的整块文本（可能含多行与 ANSI）。
   */
  append(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.contentLines.push(line);
    }
    this.requestRender();
  }

  /**
   * 追加一条完整行（立即固化，并刷新开放行）。
   *
   * @param line 单行文本（可含 ANSI）。
   */
  appendLine(line: string): void {
    if (this.buffer.length > 0) {
      this.contentLines.push(this.buffer);
      this.buffer = "";
    }
    this.contentLines.push(line);
    this.requestRender();
  }

  /**
   * 提问并等待单行回答（coding 模式确认闸门用）：把问题写入对话区，用户在下方的输入
   * 框键入并回车即作为答案；Ctrl+C 回答 null（被中断/拒绝）。
   *
   * @param question 已着色的提问文本。
   * @returns 用户输入原文；null 表示被中断。
   */
  confirm(question: string): Promise<string | null> {
    this.appendLine(question);
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  /**
   * 组合整屏帧：顶部对话区取 contentLines（含开放行）尾部，底部输入区用 box 包边；
   * 输入框下方在 `/` 面板打开时叠一个命令面板，最下方在状态行启用时追加居右的
   * 「模型 + 上下文占比」状态行。所有行最后统一按终端列宽裁剪。
   *
   * 布局顺序（上 → 下）：对话区 → 输入框 → 命令面板 → 状态行（面板与状态行高度都从
   * 对话区扣除，保证贴底）。
   *
   * @param width 终端列数。
   * @param height 终端行数。
   * @returns 整屏每一行（已是带 ANSI 的最终文本，且无任何行可见宽超过 width）。
   */
  buildFrame(width: number, height: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    // 输入区：上边框 / 输入行 / 下边框（inputBoxHeight = 3）。
    // 宽度预算：box 的内容区是 innerWidth，其两侧内边距各占 1 列、边框各占 1 列，
    // 因此留给 editor 的列数是 innerWidth - 2——否则 box 会把盒子顶到「屏宽 + 2」，
    // 末 2 列（` │` / `╯`）被终端折行走样。
    const inputLines = box([this.editor.render(innerWidth - 2)], {
      title: "ohna",
      width: innerWidth,
    });
    const inputBoxHeight = inputLines.length;

    // 候选面板：`/` 命令面板、`@` 文件面板、`/resume` 会话选择器统一渲染在输入框下方。
    // 三者输入形态互斥（命令已提交 / `@fragment` / 空输入），正常不会同时有内容。
    const panelLines = [
      ...this.sessionPicker.buildLines(),
      ...this.buildPaletteLines(),
      ...this.filePalette.buildLines(this.editor.value),
    ];
    const panelHeight = panelLines.length;

    // 状态行（模型 + 上下文占比）：存在时占 1 行，同样从对话区高度扣除，保证贴底。
    const statusLine = this.buildStatusLine(width);
    const statusHeight = statusLine === undefined ? 0 : 1;

    const dialogueHeight = Math.max(0, height - inputBoxHeight - panelHeight - statusHeight);

    const pending = this.buffer;
    const all = pending ? [...this.contentLines, pending] : this.contentLines;
    // 对话区只保留能容纳的尾部行；高度不足时仅显示最近内容 + 输入区 + 面板 + 状态行。
    const dialogueLines = all.slice(Math.max(0, all.length - dialogueHeight));

    const combined = [
      ...dialogueLines,
      ...inputLines,
      ...panelLines,
      ...(statusLine === undefined ? [] : [statusLine]),
    ];
    // 宽度安全兜底：任何一行（含长 cwd/session 的欢迎头、开放行、面板行）都不超过屏宽，
    // 因此永不折行、边框永不错位。输入区已按 innerWidth 预算，此处截断只是兜底。
    return combined.map((line) => truncateToWidth(line, width));
  }

  /**
   * 求值并渲染状态行：左侧「⏵⏵ 权限模式」，右侧「模型 · 上下文占比」。
   *
   * 布局动机（对齐 Claude Code）：权限模式是当前会话的「操作约束」，放在左下角与输入区
   * 同侧，用户不用扫到右侧数字区就能确认当前是 default / acceptEdits / plan / bypass；
   * 模型与上下文占比仍居右，保持原有视觉锚点。
   *
   * 宽度策略：先按可见宽（ANSI 不占列）计算中间填充；极窄终端（左右之和超过屏宽）时
   * 截断左侧模式文本、优先保留右侧模型/占比。占比先四舍五入再夹紧到 [0, 100]。
   *
   * @param width 终端列数。
   * @returns 左模式 + 右模型/占比的状态行；未装配 statusFn 或它返回空时返回 undefined。
   */
  private buildStatusLine(width: number): string | undefined {
    const status = this.statusFn?.();
    if (!status) return undefined;
    const percent = Math.min(100, Math.max(0, Math.round(status.contextPercent)));
    const mode = status.permissionMode ?? "default";
    const left = paint(`⏵⏵ ${mode}`, permissionModeRole(mode));
    const right = paint(status.model, "accent") + paint(` · ${percent}%`, "dim");

    // 极窄终端：保留右侧（模型/占比更关键），左侧按剩余列截断。
    if (visibleWidth(left) + visibleWidth(right) >= width) {
      const availableLeft = Math.max(0, width - visibleWidth(right) - 1);
      const trimmedLeft = availableLeft > 0 ? truncateToWidth(left, availableLeft) : "";
      const gap = Math.max(0, width - visibleWidth(trimmedLeft) - visibleWidth(right));
      return trimmedLeft + " ".repeat(gap) + right;
    }

    const gap = width - visibleWidth(left) - visibleWidth(right);
    return left + " ".repeat(gap) + right;
  }

  /**
   * 输入分发：面板打开时先消费面板导航键（Up/Down/Tab/Esc/Enter），其余照常交给编辑器。
   *
   * 每次输入/选择变化都会经 `requestRender`（编辑器 onChange 或本方法显式触发）重绘。
   *
   * @param data 原始 stdin 输入（可能是单键或一小段 chunk）。
   */
  private handleInput(data: string): void {
    // `/resume` 选择器优先：↑/↓/Enter/Esc 归选择器；可打印字符关闭面板后继续交给编辑器。
    if (this.sessionPicker.isOpen()) {
      const result = this.sessionPicker.handleKey(data);
      if (result.selectedId) {
        this.onSessionSelected?.(result.selectedId);
        this.requestRender();
        return;
      }
      if (result.consumed) {
        this.requestRender();
        return;
      }
      // 未消费（可打印字符 / 粘贴）：选择器已关闭，继续走下面的编辑器路径。
      this.requestRender();
    }
    if (this.panelOpen() && this.handlePanelKey(data)) {
      this.requestRender();
      return;
    }
    // F-6：`@fragment` 面板优先消费导航 / 补全键；未命中时按键照常进入编辑器。
    if (this.handleFilePaletteKey(data)) {
      this.requestRender();
      return;
    }    // F-2：面板关闭时识别 Esc。只有「独立 Esc」或「连续多个 Esc」才算中断手势；
    // `\x1b[A`（方向键）、`\x1bO...`（功能键）、`\x1bA`（Alt+键）整体交回编辑器，
    // 避免把 Alt+字母误判成中断。
    const { escapes, remainder } = splitLeadingEscapes(data);
    for (let i = 0; i < escapes; i += 1) this.handleEscape();
    if (remainder.length > 0) {
      // 非 Esc 输入中断「双击」判定：两下 Esc 之间若夹了别的按键，不应再算双击。
      this.lastEscapeAt = 0;
      this.editor.handleInput(remainder);
    }
    // 过滤结果可能已变化，夹紧选中下标（若面板仍打开）。
    this.selectedIndex = clampIndex(this.selectedIndex, this.filteredCommands.length);
  }

  /**
   * F-2：处理一次 Esc 按下（面板已关闭）。
   *
   * 单次 Esc 立即触发中断（复用 {@link onEscape}，仅中断 run、空闲不退出）；
   * 若距上一次 Esc 在 {@link ESC_DOUBLE_WINDOW_MS} 内，则识别为「双击」手势，占位
   * 「编辑上一条输入」（真正的 rewind 待 checkpoint/rewind 落地后启用）。
   *
   * 确认态下不走上述手势：Esc 与 Ctrl+C 一致（回答 null + 中断 run），否则确认
   * Promise 会永久悬挂；此路径直接复用编辑器装配好的 onInterrupt。
   *
   * 取舍：单次 Esc 立即中断（不引入 500ms 延迟），因此双击时第一次 Esc 已先触发中断，
   * 第二次 Esc 再补一条占位提示——这是占位阶段的合理降级，后续落地 rewind 时再收紧语义。
   */
  private handleEscape(): void {
    // 确认态：Esc 等价于 Ctrl+C（回答 null + 中断 run），否则 confirm Promise 会永久悬挂。
    if (this.confirmResolver) {
      this.editor.onInterrupt?.();
      return;
    }
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
   * `/` 面板是否打开：输入以 `/` 开头且尚未敲空格（仍在选命令名，未进入参数）。
   */
  private panelOpen(): boolean {
    const v = this.editor.value;
    return v.startsWith("/") && !/\s/.test(v);
  }

  /** 当前过滤后的命令（面板打开时）；关闭时为空数组。 */
  private get filteredCommands(): SlashCommandDef[] {
    if (!this.panelOpen()) return [];
    return filterSlashCommands(this.editor.value);
  }

  /**
   * 渲染命令面板行（面板关闭时为空数组）。选中下标在此夹紧，保证过滤变化后不越界。
   */
  private buildPaletteLines(): string[] {
    const commands = this.filteredCommands;
    if (commands.length === 0) return [];
    const selected = clampIndex(this.selectedIndex, commands.length);
    return buildPalette(commands, selected);
  }

  /** 处理 `@` 文件面板按键；Tab / Enter 命中候选时替换为 `@<相对路径> `。 */
  private handleFilePaletteKey(data: string): boolean {
    const result = this.filePalette.handleKey(data, this.editor.value);
    if (!result.consumed) return false;
    if (result.value !== undefined) {
      this.editor.value = result.value;
      this.editor.cursor = result.value.length;
      this.editor.onChange?.();
    }
    return true;
  }

  /**
   * 面板打开时消费面板专属键。返回 true 表示已消费（不再交给编辑器）。
   *
   * 键序：Up/Down 移动选中（不当作历史浏览）；Tab 补全选中命令到输入框（如 `/help `）；
   * 单字节 Esc 关闭面板；Enter 有选中项时直接提交该命令。方向键 `\x1b[A/B` 是完整三字节
   * 序列，先于单字节 Esc 匹配，raw mode 下不会被误判为 Esc。
   *
   * @param data 原始输入。
   * @returns 是否为面板键。
   */
  private handlePanelKey(data: string): boolean {
    // Esc 先于「是否有匹配项」处理：面板已打开但过滤结果为空时，Esc 仍应只关闭面板，
    // 不能落到「中断 run」分支（用户当下是在操作面板，不是在操作运行）。
    if (data === "\x1b") {
      this.lastEscapeAt = 0; // 面板关闭属于一次完整手势，避免后续 Esc 误判双击。
      this.editor.value = "";
      this.editor.cursor = 0;
      this.selectedIndex = 0;
      this.editor.onChange?.();
      return true;
    }
    const commands = this.filteredCommands;
    if (commands.length === 0) return false;
    switch (data) {
      case "\x1b[A": // Up
        this.selectedIndex = clampIndex(this.selectedIndex - 1, commands.length);
        return true;
      case "\x1b[B": // Down
        this.selectedIndex = clampIndex(this.selectedIndex + 1, commands.length);
        return true;
      case "\t": // Tab：补全选中命令，末尾补空格便于继续输入参数，面板随之关闭。
        this.completeCommand(commands[clampIndex(this.selectedIndex, commands.length)]);
        return true;
      case "\r":
      case "\n": // Enter：直接提交选中命令。
        this.submitCommand(commands[clampIndex(this.selectedIndex, commands.length)]);
        return true;
      default:
        return false;
    }
  }

  /**
   * Tab 补全：把选中命令写入输入框并在末尾补一个空格（如 `/help `），光标置行尾。
   *
   * @param command 选中的命令。
   */
  private completeCommand(command: SlashCommandDef): void {
    this.editor.value = `${command.name} `;
    this.editor.cursor = this.editor.value.length;
    this.selectedIndex = 0;
    this.editor.onChange?.();
  }

  /**
   * Enter 提交选中命令：把命令名写入输入框后走编辑器既有提交路径（复用历史/清空/回调）。
   *
   * @param command 选中的命令。
   */
  private submitCommand(command: SlashCommandDef): void {
    this.editor.value = command.name;
    this.editor.cursor = command.name.length;
    this.selectedIndex = 0;
    this.editor.handleInput("\r");
  }

  /**
   * 启动整屏 TUI：接管终端、装配渲染与输入、注册编辑器回调、绘制首帧。
   *
   * 注意：进入前隐藏硬件光标（编辑位置仅凭反色块指示），退出时恢复。
   */
  start(): void {
    process.stdout.write("\x1b[?25l");
    this.screen.setRenderFn((w, h) => this.buildFrame(w, h));
    this.screen.setOnInput((d) => this.handleInput(d));

    // 提交：确认态下解析 confirm，否则上交上层（repl 的 processLine）。
    this.editor.onSubmit = (value) => {
      // 提交成功即结束 Esc 手势窗口，避免紧接着的 Esc 被误判为「双击」。
      this.lastEscapeAt = 0;
      if (this.confirmResolver) {
        const resolver = this.confirmResolver;
        this.confirmResolver = undefined;
        this.editor.value = "";
        this.editor.cursor = 0;
        this.editor.onChange?.();
        resolver(value);
        return;
      }
      this.onSubmit?.(value);
    };

    // 中断：确认态下回答 null 并同时尝试中断进行中的 run；否则上交上层。
    this.editor.onInterrupt = () => {
      if (this.confirmResolver) {
        const resolver = this.confirmResolver;
        this.confirmResolver = undefined;
        this.editor.value = "";
        this.editor.cursor = 0;
        this.editor.onChange?.();
        resolver(null);
        this.onInterrupt?.();
        return;
      }
      this.onInterrupt?.();
    };

    this.editor.onChange = () => this.requestRender();
    // F-3：Ctrl+O 切换 verbose（确认态下不切换，与提交/中断一致）。
    this.editor.onVerboseToggle = () => {
      if (this.confirmResolver) return;
      this.onVerboseToggle?.();
    };
    // B2：Shift+Tab 循环权限模式；确认态下不切换，避免审批问题被模式切换打断。
    this.editor.onModeCycle = () => {
      if (this.confirmResolver) return;
      this.onModeCycle?.();
    };
    this.screen.start();
    this.requestRender(); // 首帧立即绘制（含已注入的欢迎头）
  }

  /**
   * 停止整屏 TUI：交还终端控制权并恢复硬件光标。
   */
  stop(): void {
    this.screen.stop();
    process.stdout.write("\x1b[?25h");
  }

  /**
   * 触发一次整屏重绘（委托 Screen 节流）。
   */
  private requestRender(): void {
    this.screen.requestRender();
  }
}
