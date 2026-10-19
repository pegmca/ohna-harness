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
import { RawTerminal, Screen, box, truncateToWidth } from "@aiagent/term";
import { paint } from "./theme.js";
import { LineEditor } from "./tui-editor.js";
import { filterSlashCommands, type SlashCommandDef } from "./slash.js";

/** 命令面板最多显示的条目数（超出部分滚动不到，MVP 截断即可）。 */
export const MAX_PALETTE_ITEMS = 8;

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

/** TuiApp 的构造选项。 */
export interface TuiAppOptions {
  /** 输入框提示符（可带色）；缺省 `❯ `（user 色）。 */
  prompt?: string;
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
  /** 对话内容：已固化的「含 ANSI 最终行」，追加式增长。 */
  private contentLines: string[] = [];
  /** 当前未结束的开放行：流式 delta 累积于此，遇 `\n` 固化为 contentLines 一项。 */
  private buffer = "";
  /** 进行中的确认解析器：存在时编辑器提交/中断改走确认语义。 */
  private confirmResolver?: (value: string | null) => void;

  /** `/` 命令面板的选中下标（面板关闭时无意义，见 {@link filteredCommands}）。 */
  private selectedIndex = 0;

  /** 提交钩子：用户按 Enter（且非确认态）时以输入文本调用。 */
  onSubmit?: (value: string) => void;
  /** 中断钩子：用户按 Ctrl+C（且非确认态）时调用（上层决定中断 run 或退出）。 */
  onInterrupt?: () => void;

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
   * 输入框下方在 `/` 面板打开时叠一个命令面板。所有行最后统一按终端列宽裁剪。
   *
   * 布局顺序（上 → 下）：对话区 → 输入框 → 命令面板（面板高度从对话区扣除，保证贴底）。
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

    // 命令面板：`/` 开头且尚无空格时打开，渲染在输入框下方，高度从对话区扣除。
    const panelLines = this.buildPaletteLines();
    const panelHeight = panelLines.length;

    const dialogueHeight = Math.max(0, height - inputBoxHeight - panelHeight);

    const pending = this.buffer;
    const all = pending ? [...this.contentLines, pending] : this.contentLines;
    // 对话区只保留能容纳的尾部行；高度不足时仅显示最近内容 + 输入区 + 面板。
    const dialogueLines = all.slice(Math.max(0, all.length - dialogueHeight));

    const combined = [...dialogueLines, ...inputLines, ...panelLines];
    // 宽度安全兜底：任何一行（含长 cwd/session 的欢迎头、开放行、面板行）都不超过屏宽，
    // 因此永不折行、边框永不错位。输入区已按 innerWidth 预算，此处截断只是兜底。
    return combined.map((line) => truncateToWidth(line, width));
  }

  /**
   * 输入分发：面板打开时先消费面板导航键（Up/Down/Tab/Esc/Enter），其余照常交给编辑器。
   *
   * 每次输入/选择变化都会经 `requestRender`（编辑器 onChange 或本方法显式触发）重绘。
   *
   * @param data 原始 stdin 输入（可能是单键或一小段 chunk）。
   */
  private handleInput(data: string): void {
    if (this.panelOpen() && this.handlePanelKey(data)) {
      this.requestRender();
      return;
    }
    this.editor.handleInput(data);
    // 过滤结果可能已变化，夹紧选中下标（若面板仍打开）。
    this.selectedIndex = clampIndex(this.selectedIndex, this.filteredCommands.length);
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
      case "\x1b": // 单字节 Esc：关闭面板（清空输入，恢复空行）。
        this.editor.value = "";
        this.editor.cursor = 0;
        this.selectedIndex = 0;
        this.editor.onChange?.();
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
