/**
 * Screen：整屏 TUI 渲染循环（节流 + 行差分重绘）。
 *
 * 核心思路来自 pi-tui 的成熟方案，用于根治 readline 滚动输出在 resize 时无法安全重绘、
 * 从而引发「风暴」的问题：
 *
 * 1. 节流（requestRender）：用 `renderRequested` 标志 + `MIN_RENDER_INTERVAL_MS` 去抖，
 *    同一事件循环 tick 内的多次请求只排程一次真正的绘制，避免高频输入/连续 resize 触发风暴。
 * 2. 行差分（doRender）：首帧与尺寸变化时仍走 `clearScreen()` + 整帧全写（保留幂等语义）；
 *    其余情况逐行比较**含 ANSI 的原始字节串**，只对变化行做「回到行首 + clearLine + 重写」，
 *    行数减少时逐行清除末尾多余行。差分是 Screen 内部优化，调用方零感知：
 *    RenderFn 仍返回整帧最终行。
 * 3. 渲染与布局分离：整屏内容由调用方通过 `setRenderFn` 提供（返回已是带 ANSI 的最终文本），
 *    Screen 不关心行内语义与颜色，只负责「取尺寸 → 调回调 → 位置光标 → 写变化行」。
 */
import type { Terminal } from "./terminal.js";

/** 渲染节流最小间隔（毫秒）。16ms ≈ 60fps 上限，去抖高频渲染请求。 */
const MIN_RENDER_INTERVAL_MS = 16;

/** 整屏内容生成函数：给定当前宽高，返回整屏每一行（已是带 ANSI 的最终文本）。 */
export type RenderFn = (width: number, height: number) => string[];

/** 输入透传回调：Screen 不实现编辑逻辑，只把原始 stdin 数据转交给调用方。 */
export type InputFn = (data: string) => void;

/**
 * 整屏渲染器：驱动一个 {@link Terminal} 做节流 + 行差分重绘。
 *
 * 首帧与 resize 走全量清屏重绘，其余帧只重写变化行；对调用方保持
 * 「返回整帧最终行」的契约不变。
 *
 * 典型用法：
 * ```ts
 * const screen = new Screen(terminal);
 * screen.setRenderFn((w, h) => buildFrame(w, h)); // 调用方负责内容/边框/颜色
 * screen.setOnInput((data) => editor.handle(data));
 * screen.start();
 * ```
 */
export class Screen {
  /** 节流窗口，固定为 16ms（见模块常量）。 */
  static readonly MIN_RENDER_INTERVAL_MS = MIN_RENDER_INTERVAL_MS;

  /** 被驱动的终端（注入接口，便于测试用假终端）。 */
  private readonly terminal: Terminal;

  /** 当前整屏内容生成函数（由调用方设置）。 */
  private renderFn?: RenderFn;

  /** 当前输入透传回调（由调用方设置）。 */
  private onInputFn?: InputFn;

  /** 是否已请求渲染（去抖标志）。 */
  private renderRequested = false;

  /** 已排程的渲染定时器句柄。 */
  private renderTimer?: ReturnType<typeof setTimeout>;

  /** 上次真正绘制的时间戳（用于计算节流延迟）。 */
  private lastRenderAt = 0;

  /** 上一帧的最终行（含 ANSI 原始字节串），差分比较的唯一事实源。 */
  private prevFrame: string[] = [];

  /** 上一帧绘制时的终端列数，用于判定 resize。 */
  private prevWidth = 0;

  /** 上一帧绘制时的终端行数，用于判定 resize。 */
  private prevHeight = 0;

  /** 是否已成功绘制过至少一帧；首帧必须走全量重绘。 */
  private hasRenderedFrame = false;

  /**
   * 构造一个整屏渲染器。
   *
   * @param terminal 实现 {@link Terminal} 接口的终端（真实或测试用假实现）。
   */
  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  /**
   * 设置整屏内容生成函数（调用方提供，返回整屏所有行：边框/内容/输入行）。
   *
   * @param fn 渲染回调。传 `undefined` 可清空。
   */
  setRenderFn(fn: RenderFn | undefined): void {
    this.renderFn = fn;
  }

  /**
   * 设置输入透传回调：Screen 不做编辑，仅把 stdin 原始数据转发给调用方。
   *
   * @param fn 输入回调。传 `undefined` 可清空。
   */
  setOnInput(fn: InputFn | undefined): void {
    this.onInputFn = fn;
  }

  /**
   * 请求一次渲染（节流）。
   *
   * 同一 tick 内的多次调用只会排程一次真正绘制：首调用置 `renderRequested` 并排程定时器，
   * 后续调用直接返回。`force=true` 用于「尺寸/状态已变、必须立即重绘」的场景——
   * 清除已排程定时器并把上次绘制时间归零，使本次调度延迟为 0（立即）。
   *
   * @param force 是否强制立即重绘（默认 false）。
   */
  requestRender(force = false): void {
    if (force) {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
      }
      // 归零上次绘制时间 → 调度延迟为 0，立即排程。
      this.lastRenderAt = 0;
      this.renderRequested = true;
      this.scheduleRender();
      return;
    }
    if (this.renderRequested) return; // 已排程，去抖。
    this.renderRequested = true;
    this.scheduleRender();
  }

  /**
   * 按节流窗口排程一次 doRender：若距上次渲染不足间隔，则延迟补足。
   */
  private scheduleRender(): void {
    if (this.renderTimer || !this.renderRequested) return;
    const elapsed = Date.now() - this.lastRenderAt;
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.renderRequested) return;
      this.renderRequested = false;
      this.lastRenderAt = Date.now();
      this.doRender();
    }, delay);
  }

  /**
   * 执行一次绘制：首帧 / 尺寸变化走全量重绘，其余情况只写变化行。
   *
   * 逐行比较使用**含 ANSI 的原始字节串**（不做 stripAnsi），避免「颜色变了但文本没变」
   * 被误判为无变化。帧内容与尺寸都未变时直接返回，不产生任何终端写入。
   */
  private doRender(): void {
    const width = this.terminal.columns;
    const height = this.terminal.rows;
    const lines = this.renderFn ? this.renderFn(width, height) : [];
    // 防御性钳制（M1）：RenderFn 返回行数超过屏高时只取前 rows 行，保证任何调用方
    // 都无法驱动差分写出越过终端底部的行（差分按行位移，越界会污染滚动缓冲）。
    // height<=0 表示终端尺寸未知（非 TTY 兜底），此时不裁剪，交由调用方处理。
    const frame = height > 0 ? lines.slice(0, height) : lines;

    // 首帧与 resize 必须全量重绘：旧帧的行数与折行关系都已失效，只有清屏能保证幂等。
    const needsFullRedraw =
      !this.hasRenderedFrame || width !== this.prevWidth || height !== this.prevHeight;
    if (needsFullRedraw) {
      this.renderFullFrame(frame, width, height);
      return;
    }

    // 内容完全一致时连光标移动都不写，减少流式渲染期间的 stdout 噪声。
    if (this.framesEqual(this.prevFrame, frame)) return;

    this.renderDiff(this.prevFrame, frame);
    this.prevFrame = frame.slice();
  }

  /**
   * 全量重绘：先清屏回到左上角，再一次性写出以 `\r\n` 连接的整帧。
   *
   * 这是首帧与 resize 的兜底路径，保留原「幂等全量重绘」语义：连续 resize 也只会
   * 画出同一帧，不会残留旧尺寸的行。
   *
   * @param lines 当前帧的最终行（含 ANSI）。
   * @param width 当前终端列数。
   * @param height 当前终端行数。
   * @returns 无
   */
  private renderFullFrame(lines: string[], width: number, height: number): void {
    this.terminal.clearScreen();
    this.terminal.write(lines.join("\r\n"));

    this.prevFrame = lines.slice();
    this.prevWidth = width;
    this.prevHeight = height;
    this.hasRenderedFrame = true;
  }

  /**
   * 行差分重绘：从上一帧末尾回到帧起点，逐行向下，只重写内容变化的行。
   *
   * 输出协议（测试据此断言）：
   * 1. 若上一帧多于 1 行，`moveCursorUp(prev.length - 1)` 回到帧首行；`moveCursorToColumn(1)`
   *    回到行首（列位置与行位移无关）。
   * 2. 逐行 `moveCursorDown(1)` 下移；变化行输出 `\r` + `clearLine()` + 新行内容；
   *    未变化行只下移、不写文本。
   * 3. 新帧比旧帧短时，多出的尾部行逐行 `\r` + `clearLine()` 清除，再把光标移回
   *    新帧最后一行（新帧为空时回到帧首行），保证下一次差分仍从「帧末尾」起算。
   *
   * 全量清屏不参与常规差分；只有首帧 / resize 走 {@link renderFullFrame}。
   *
   * @param prev 上一帧的最终行。
   * @param next 当前帧的最终行。
   * @returns 无
   */
  private renderDiff(prev: string[], next: string[]): void {
    if (prev.length > 1) {
      this.terminal.moveCursorUp(prev.length - 1);
    }
    this.terminal.moveCursorToColumn(1);

    const rowCount = Math.max(prev.length, next.length);
    for (let i = 0; i < rowCount; i += 1) {
      if (i > 0) this.terminal.moveCursorDown(1);

      if (i < next.length) {
        // 变化行：回到行首、清掉旧内容、写新内容；未变化行保持原样。
        if (i >= prev.length || next[i] !== prev[i]) {
          this.terminal.write("\r");
          this.terminal.clearLine();
          this.terminal.write(next[i]);
        }
        continue;
      }

      // 新帧没有这一行：清掉上一帧遗留的尾部内容。
      this.terminal.write("\r");
      this.terminal.clearLine();
    }

    // 行数减少后光标停在已清除的尾部；移回新帧最后一行，维持下次差分的起点假设。
    if (prev.length > next.length) {
      const targetRow = Math.max(next.length - 1, 0);
      const currentRow = prev.length - 1;
      const moveUp = currentRow - targetRow;
      if (moveUp > 0) this.terminal.moveCursorUp(moveUp);
    }
  }

  /**
   * 判断两帧是否逐行完全相同（字符串原始比较，包含 ANSI 序列）。
   *
   * @param a 上一帧。
   * @param b 当前帧。
   * @returns 行数与每行内容都相同时为 true。
   */
  private framesEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * 输入转发：把原始 stdin 数据透传给当前输入回调（由调用方驱动输入框编辑）。
   *
   * @param data 原始输入字节（UTF-8 字符串）。
   */
  private handleInput(data: string): void {
    this.onInputFn?.(data);
  }

  /**
   * 启动渲染器：接管终端的输入与 resize，resize 仅触发一次节流重绘。
   */
  start(): void {
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(),
    );
  }

  /** 停止渲染器：交还终端控制权（还原 raw mode、移除监听等由终端负责）。 */
  stop(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.terminal.stop();
  }
}
