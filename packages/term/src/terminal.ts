/**
 * RawTerminal：裁剪版 ProcessTerminal，提供 raw mode + 尺寸/输入回调的最小终端接入。
 *
 * 设计取舍（来自 pi-tui 的成熟方案但只取最小子集）：
 * - 用 raw mode 接管 stdin，使方向键/ESC 序列能逐字节交给调用方而非被行编辑缓冲吞掉；
 * - 监听 `process.stdout` 的 `"resize"` 事件，并在非 win32 下发一次 SIGWINCH 刷新尺寸，
 *   解决挂起/恢复后尺寸过期的竞态；
 * - 启用 bracketed paste（`\x1b[?2004h`），让粘贴块被 `\x1b[200~…\x1b[201~` 包裹，
 *   调用方可整体处理而不会被拆成多次输入；
 * - 不做 Kitty 键盘协议 / modifyOtherKeys / 原生修饰键协商——那是无关复杂度，本阶段去掉。
 *
 * 包边界：RawTerminal 只负责「终端原语」，颜色/语义由调用方（ohna-cli 的 theme.ts）决定。
 */

/**
 * 终端最小接口：Screen 仅依赖这个子集，便于测试时注入假实现。
 */
export interface Terminal {
  /** 启动终端，注册输入与 resize 回调。 */
  start(onInput: (data: string) => void, onResize: () => void): void;
  /** 停止并还原终端状态。 */
  stop(): void;
  /** 向 stdout 写入原始字节。 */
  write(data: string): void;
  /** 终端列数（可见宽度）。 */
  get columns(): number;
  /** 终端行数（可见高度）。 */
  get rows(): number;
  /** 清屏并回到左上角（等价 `\x1b[2J\x1b[H`）。 */
  clearScreen(): void;
}

/**
 * 进程级 raw mode 终端：基于 process.stdin/stdout 的真实实现，实现 {@link Terminal} 接口。
 */
export class RawTerminal implements Terminal {
  /** 进入前的 raw 状态，stop 时还原，避免污染父 shell。 */
  private wasRaw = false;
  /** 当前输入回调（由 start 注入，stop 时清空）。 */
  private inputHandler?: (data: string) => void;
  /** 当前 resize 回调引用，stop 时按同一引用移除监听。 */
  private resizeListener?: () => void;
  /** 绑定后的 stdin data 处理，保证 add/removeListener 引用一致。 */
  private readonly stdinDataHandler = (data: string): void => {
    this.inputHandler?.(data);
  };

  /**
   * 进入 raw mode 并注册输入/尺寸回调。
   *
   * 副作用：保存 raw 状态、开启 raw mode、UTF-8 编码、resume stdin、启用 bracketed
   * paste、监听 stdout resize；非 win32 下补发 SIGWINCH 以刷新可能过期的尺寸。
   *
   * @param onInput  stdin 收到字节时回调（已为 UTF-8 字符串）。
   * @param onResize stdout 尺寸变化时回调（用于触发一次重绘）。
   */
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeListener = onResize;

    // 记录并开启 raw mode；调用方可能在 raw 下再次启动，需还原到原状态。
    this.wasRaw = process.stdin.isRaw || false;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    // 启用 bracketed paste：粘贴内容会被 \x1b[200~ … \x1b[201~ 包裹。
    process.stdout.write("\x1b[?2004h");

    // 立即挂上 resize 监听；尺寸变化只触发一次重绘（见 Screen.requestRender 节流）。
    process.stdout.on("resize", this.resizeListener);

    // 挂起/恢复后 SIGWINCH 会丢失，主动补发一次以刷新可能过期的列/行数（Unix only）。
    if (process.platform !== "win32") {
      try {
        process.kill(process.pid, "SIGWINCH");
      } catch {
        // 极端情况下 kill 可能抛错（如权限），忽略即可，尺寸仍可由 resize 事件更新。
      }
    }

    process.stdin.on("data", this.stdinDataHandler);
  }

  /**
   * 停止终端并还原状态：关闭 bracketed paste、移除监听、pause stdin、还原 raw mode。
   */
  stop(): void {
    // 关闭 bracketed paste，否则退出后粘贴仍会被包裹。
    process.stdout.write("\x1b[?2004l");

    process.stdin.removeListener("data", this.stdinDataHandler);
    if (this.resizeListener) {
      process.stdout.removeListener("resize", this.resizeListener);
      this.resizeListener = undefined;
    }

    // pause stdin 防止缓冲输入（如 Ctrl+D）在 raw 关闭后被父 shell 误读。
    process.stdin.pause();

    // 还原进入前的 raw 状态，不强行关闭（调用方可能本来就在 raw）。
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(this.wasRaw);
    }
    this.inputHandler = undefined;
  }

  /** 向 stdout 写入原始内容。 */
  write(data: string): void {
    process.stdout.write(data);
  }

  /**
   * 终端列数。
   *
   * 回退链：`process.stdout.columns` → 环境变量 `COLUMNS` → 默认 80。
   * 非 TTY（如管道/测试）下 stdout.columns 为空，由 env 或默认值兜底。
   */
  get columns(): number {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80;
  }

  /**
   * 终端行数。
   *
   * 回退链：`process.stdout.rows` → 环境变量 `LINES` → 默认 24。
   */
  get rows(): number {
    return process.stdout.rows || Number(process.env.LINES) || 24;
  }

  /** 清屏并移动光标到左上角（等价 `\x1b[2J\x1b[H`）。 */
  clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  /** 隐藏光标（`\x1b[?25l`）。 */
  hideCursor(): void {
    process.stdout.write("\x1b[?25l");
  }

  /** 显示光标（`\x1b[?25h`）。 */
  showCursor(): void {
    process.stdout.write("\x1b[?25h");
  }

  /** 清除当前行光标之后的内容（`\x1b[K`）。 */
  clearLine(): void {
    process.stdout.write("\x1b[K");
  }
}
