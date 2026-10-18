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
import { RawTerminal, Screen, box } from "@aiagent/term";
import { paint } from "./theme.js";
import { LineEditor } from "./tui-editor.js";

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
   * 组合整屏帧：顶部对话区取 contentLines（含开放行）尾部，底部输入区用 box 包边。
   *
   * @param width 终端列数。
   * @param height 终端行数。
   * @returns 整屏每一行（已是带 ANSI 的最终文本）。
   */
  buildFrame(width: number, height: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    // 输入区：上边框 / 输入行 / 下边框（inputBoxHeight = 3）。
    const inputLines = box([this.editor.render(innerWidth)], { title: "ohna", width: innerWidth });
    const inputBoxHeight = inputLines.length;
    const dialogueHeight = Math.max(0, height - inputBoxHeight);

    const pending = this.buffer;
    const all = pending ? [...this.contentLines, pending] : this.contentLines;
    // 对话区只保留能容纳的尾部行；高度不足时仅显示最近内容 + 输入区。
    const dialogueLines = all.slice(Math.max(0, all.length - dialogueHeight));

    return [...dialogueLines, ...inputLines];
  }

  /**
   * 启动整屏 TUI：接管终端、装配渲染与输入、注册编辑器回调、绘制首帧。
   *
   * 注意：进入前隐藏硬件光标（编辑位置仅凭反色块指示），退出时恢复。
   */
  start(): void {
    process.stdout.write("\x1b[?25l");
    this.screen.setRenderFn((w, h) => this.buildFrame(w, h));
    this.screen.setOnInput((d) => this.editor.handleInput(d));

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
