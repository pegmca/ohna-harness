/**
 * 精简整屏输入编辑器（raw mode 单行 line editor）。
 *
 * 设计取舍（相比完整 TUI 输入组件大幅精简，只保留 Phase B1 MVP 需要的最小键集）：
 * - raw mode 下 stdin 不再做行编辑缓冲，所有原始序列（UTF-8 字符串）逐字节交给本类；
 * - 支持：可打印字符插入、退格（`\x7f` / `\x08`）、左右光标（`\x1b[C` / `\x1b[D`）、
 *   Home/End（`\x1b[H` / `\x1b[1~` / `\x1b[F` / `\x1b[4~`）、Enter（`\r` 或 `\n`）提交、
 *   Ctrl+C（`\x03`）中断、上下方向键（`\x1b[A` / `\x1b[B`）历史、bracketed paste；
 * - 不做 kill-ring / undo / word-nav / 水平滚动；超长输入直接从左裁切（MVP 假设宽度足够）。
 *
 * 输入解析：一次 stdin chunk 可能含多个键（快速连打 / IME 上屏 / 管道注入），因此
 * {@link LineEditor.handleInput} 先切出 bracketed paste 区块，再逐「转义序列 / 单字符」分发，
 * 绝不整体比对——否则多键 chunk 会被整段丢弃。
 *
 * 光标高亮：光标所在字符用 reverse video（`\x1b[7m … \x1b[27m`）渲染，光标在行尾时
 * 用空格占位高亮，参考 badlogic/tui 输入组件的 `cursorChar` 做法；硬件光标由 TuiApp 隐藏，
 * 仅靠反色块指示编辑位置。
 *
 * 键序列说明（raw mode 下终端发来的原始字节）：
 * - 方向键是 3 字节转义序列 `\x1b[A/B/C/D`，Home/End 是 `\x1b[H`/`\x1b[F`（或 `\x1b[1~`/`\x1b[4~`），
 *   Enter 是 `\r`（`\u000d`，部分终端为 `\n`），Ctrl+C 是 `\x03`（不是 `\x1b`）。
 */
import { visibleWidth } from "@aiagent/term";

/** bracketed paste 起始标记：终端在开启 `\x1b[?2004h` 后用这一对标记包裹粘贴内容。 */
const PASTE_START = "\x1b[200~";
/** bracketed paste 结束标记。 */
const PASTE_END = "\x1b[201~";

/**
 * 从 `start` 处读取一个完整的 ESC 序列（ESC … 最终字节）。
 *
 * 只识别 CSI 形态（`ESC [` + 参数/中间字节 + `@`~`~` 之间的最终字节）；其余 ESC 前缀
 * （如 Alt+键）按两字节整体返回，交由上层忽略。序列被 chunk 边界截断时返回 null。
 *
 * @param input 输入串。
 * @param start ESC 所在下标。
 * @returns 序列文本与长度；不完整时返回 null。
 */
function readEscapeSequence(input: string, start: number): { text: string; length: number } | null {
  const next = input[start + 1];
  if (next === undefined) return null; // 只剩一个 ESC，等下一次 chunk（MVP 直接丢弃）
  if (next !== "[") return { text: `\x1b${next}`, length: 2 };

  let i = start + 2;
  // 参数字节（0-9 ; : < = > ?）与中间字节（空格 ~ `/`）后紧跟最终字节（@ ~ ~）。
  while (i < input.length && /[0-9;:<=>?]/.test(input[i])) i += 1;
  while (i < input.length && input[i] >= " " && input[i] <= "/") i += 1;
  if (i >= input.length) return null; // 未读到最终字节：不完整
  return { text: input.slice(start, i + 1), length: i + 1 - start };
}

/** 输入编辑器的构造选项。 */
export interface LineEditorOptions {
  /** 输入框提示符（可已带色，如 theme 的 `paint("❯ ","user")`）；缺省 `> `。 */
  prompt?: string;
  /** 初始历史（如恢复会话时载入）；缺省空。 */
  history?: string[];
}

/**
 * 单行整屏输入编辑器：维护 value / cursor / history，解析 raw 输入序列并产出单行渲染。
 *
 * 与完整 TUI 组件不同，本类只负责「编辑状态 + 渲染」，不持有终端也不负责整屏布局，
 * 整屏组合由 {@link TuiApp} 负责。
 */
export class LineEditor {
  /** 当前输入文本。 */
  value = "";
  /** 光标在 value 中的字符下标（0 = 行首）。 */
  cursor = 0;
  /** 提交历史（已提交的非空输入）。 */
  history: string[];
  /** 历史浏览位置；-1 表示未在浏览（正在编辑当前行）。 */
  private historyIndex = -1;
  /** 进入历史浏览前保存的当前行草稿，浏览结束后回退。 */
  private draft = "";
  /** 输入框提示符（可能含 ANSI）。 */
  private readonly prompt: string;

  /** bracketed paste 进行中标志（跨 chunk 缓冲）。 */
  private pasting = false;
  /** bracketed paste 缓冲（起始标记 `\x1b[200~` 之后、结束标记 `\x1b[201~` 之前的内容）。 */
  private pasteBuffer = "";

  /** 提交回调：用户按 Enter 时以当前 value 调用。 */
  onSubmit?: (value: string) => void;
  /** 中断回调：用户按 Ctrl+C 时调用（由上层决定中断 run 还是退出）。 */
  onInterrupt?: () => void;
  /** verbose 切换回调：用户按 Ctrl+O（`\x0f`）时调用（F-3，由上层切换开关并重打折叠块）。 */
  onVerboseToggle?: () => void;
  /** 权限模式循环回调：用户按 Shift+Tab（`\x1b[Z`）时调用（B2，由上层循环预设）。 */
  onModeCycle?: () => void;
  /** 内容变化回调：每次 value/cursor 改变后调用（用于触发 requestRender）。 */
  onChange?: () => void;

  /**
   * 构造输入编辑器。
   *
   * @param options 可选提示符与初始历史。
   */
  constructor(options?: LineEditorOptions) {
    this.prompt = options?.prompt ?? "> ";
    this.history = options?.history ?? [];
  }

  /**
   * 解析并处理一段原始 stdin 输入（raw mode 下为 UTF-8 字符串）。
   *
   * 一次 `data` 可能包含多个键（快速连打、IME 上屏、管道注入），因此不能整体比对：
   * 先切出 bracketed paste 区块（可能跨 chunk），其余部分按「转义序列 / 单字符」逐个分发。
   *
   * @param data 原始输入字节（UTF-8 字符串）。
   */
  handleInput(data: string): void {
    let rest = data;
    while (rest.length > 0) {
      if (this.pasting) {
        // 粘贴进行中：只关心结束标记，其余全部进缓冲（可能跨 chunk）。
        const endIdx = rest.indexOf("\x1b[201~");
        if (endIdx === -1) {
          this.pasteBuffer += rest;
          return;
        }
        this.pasteBuffer += rest.slice(0, endIdx);
        rest = rest.slice(endIdx + PASTE_END.length);
        this.pasting = false;
        this.flushPaste();
        continue;
      }

      const startIdx = rest.indexOf(PASTE_START);
      if (startIdx >= 0) {
        // 标记之前的普通按键先分发，再进入粘贴态。
        this.consumeKeys(rest.slice(0, startIdx));
        rest = rest.slice(startIdx + PASTE_START.length);
        this.pasting = true;
        continue;
      }

      this.consumeKeys(rest);
      return;
    }
  }

  /**
   * 逐键分发一段「不含粘贴标记」的普通输入：转义序列整体匹配，其余按单字符处理。
   *
   * @param input 待分发的按键流。
   */
  private consumeKeys(input: string): void {
    let i = 0;
    while (i < input.length) {
      if (input[i] !== "\x1b") {
        this.handleKey(input[i]);
        i += 1;
        continue;
      }
      const seq = readEscapeSequence(input, i);
      // 序列不完整（chunk 边界截断）：残余字节丢弃即可，粘贴/方向键不会跨 chunk 拆分。
      if (!seq) return;
      this.handleKey(seq.text);
      i += seq.length;
    }
  }

  /**
   * 分发单个键（单字符或一个完整转义序列）。
   *
   * 优先级：Ctrl+C 中断 → Enter 提交 → 退格 → 方向键 / Home·End → 可打印字符插入。
   *
   * @param key 单字符或转义序列（如 `\x1b[A`）。
   */
  private handleKey(key: string): void {
    switch (key) {
      // Ctrl+C（raw mode 下为 `\x03`）：中断当前 run，空闲时退出。
      case "\x03":
        this.onInterrupt?.();
        return;
      // Ctrl+O（`\x0f`）：切换 verbose 并重打折叠块全文（F-3）。
      case "\x0f":
        this.onVerboseToggle?.();
        return;
      // Shift+Tab（CSI Z，`\x1b[Z`）：循环权限模式 default → acceptEdits → plan（B2）。
      case "\x1b[Z":
        this.onModeCycle?.();
        return;
      // 提交：`\r`（默认 Enter）或 `\n`。
      case "\r":
      case "\n":
        this.submit();
        return;
      // 退格：现代终端发 DEL（`\x7f`），部分环境发 BS（`\x08`）。
      case "\x7f":
      case "\x08":
        this.backspace();
        return;
      case "\x1b[A":
        this.moveHistory(-1);
        return;
      case "\x1b[B":
        this.moveHistory(1);
        return;
      case "\x1b[C":
        this.moveCursor(1);
        return;
      case "\x1b[D":
        this.moveCursor(-1);
        return;
      case "\x1b[H":
      case "\x1b[1~":
        this.cursor = 0;
        this.onChange?.();
        return;
      case "\x1b[F":
      case "\x1b[4~":
        this.cursor = this.value.length;
        this.onChange?.();
        return;
      default:
        break;
    }
    // 可打印字符：拒绝 C0（`\x00-\x1f`）/ DEL（`\x7f`）/ C1（`\x80-\x9f`）控制字符。
    if (this.isPrintable(key)) {
      this.insert(key);
    }
  }

  /**
   * 渲染单行输入框内容（不含外框；外框由 box() 负责）。
   *
   * 光标所在字符以 reverse video 高亮，行尾时以空格占位高亮；超长输入从左裁切到 width。
   *
   * @param width 输入框内可用可见宽度（已扣除外框，即 `屏宽 - 2`）。
   * @returns 单行渲染文本（可能含 ANSI 光标高亮）。
   */
  render(width: number): string {
    const cursorChar = this.value[this.cursor] ?? " ";
    let before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor + 1);
    // reverse video 包裹光标下字符：`\x1b[7m` 开、`\x1b[27m` 关。
    const highlighted = `\x1b[7m${cursorChar}\x1b[27m`;
    let text = this.prompt + before + highlighted + after;

    // MVP 不做水平滚动：超出宽度时从 before 左侧逐步裁切，保证光标始终可见。
    while (visibleWidth(text) > width && before.length > 0) {
      const dropped = before.slice(1);
      text = this.prompt + dropped + highlighted + after;
      before = dropped;
    }
    return text;
  }

  /**
   * 提交当前输入：非空内容入历史，清空 value/cursor，并触发 onSubmit 与 onChange。
   */
  private submit(): void {
    const value = this.value;
    if (value.trim().length > 0) {
      this.history.push(value);
    }
    this.historyIndex = -1;
    this.draft = "";
    this.value = "";
    this.cursor = 0;
    this.onSubmit?.(value);
    this.onChange?.();
  }

  /**
   * 在光标处插入文本并右移光标。
   *
   * @param text 待插入的可打印文本（可能是 IME 上屏的多字符或粘贴块）。
   */
  private insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.onChange?.();
  }

  /**
   * 删除光标左侧一个字符（若存在）。
   */
  private backspace(): void {
    if (this.cursor > 0) {
      this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
      this.cursor -= 1;
      this.onChange?.();
    }
  }

  /**
   * 左右移动光标。
   *
   * @param delta +1 右移、-1 左移。
   */
  private moveCursor(delta: number): void {
    const next = this.cursor + delta;
    if (next >= 0 && next <= this.value.length) {
      this.cursor = next;
      this.onChange?.();
    }
  }

  /**
   * 上下方向键浏览历史：上翻保留草稿并替换 value，下翻越过最新项后回退草稿。
   *
   * @param dir -1 上翻历史、-1 之外 1 下翻。
   */
  private moveHistory(dir: -1 | 1): void {
    if (this.history.length === 0) return;
    if (dir === -1) {
      if (this.historyIndex === -1) {
        this.draft = this.value;
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
      } else {
        return; // 已在最旧项
      }
    } else {
      if (this.historyIndex === -1) return;
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex += 1;
      } else {
        this.historyIndex = -1;
        this.value = this.draft;
        this.cursor = this.value.length;
        this.onChange?.();
        return;
      }
    }
    this.value = this.history[this.historyIndex];
    this.cursor = this.value.length;
    this.onChange?.();
  }

  /**
   * 冲刷粘贴缓冲：把换行/制表扁平化为空格、剔除残余控制字符后一次性插入光标处。
   *
   * 为什么扁平化：MVP 输入框是单行的，粘贴多行文本不能真的产生换行（会打断整屏布局）。
   */
  private flushPaste(): void {
    const pasted = this.pasteBuffer
      .replace(/\r\n/g, " ")
      .replace(/[\r\n\t]/g, " ")
      .replace(/[\x00-\x1f]/g, "");
    this.pasteBuffer = "";
    if (pasted.length > 0) this.insert(pasted);
  }

  /**
   * 判断一段数据是否全为可打印字符（无控制字符）。
   *
   * @param data 待判定字符串。
   * @returns 全可打印时返回 true。
   */
  private isPrintable(data: string): boolean {
    if (data.length === 0) return false;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
    }
    return true;
  }
}
