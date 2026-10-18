/**
 * Screen：整屏 TUI 渲染循环（裁剪版 TUI 的渲染模型，但只做全量幂等重绘）。
 *
 * 核心思路来自 pi-tui 的成熟方案，用于根治 readline 滚动输出在 resize 时无法安全重绘、
 * 从而引发「风暴」的问题：
 *
 * 1. 节流（requestRender）：用 `renderRequested` 标志 + `MIN_RENDER_INTERVAL_MS` 去抖，
 *    同一事件循环 tick 内的多次请求只排程一次真正的绘制，避免高频输入/连续 resize 触发风暴。
 * 2. 幂等重绘（doRender）：每次都先 `clearScreen()` 再全量重写当前帧，因此 resize 连续
 *    触发也只会画出同一帧，永不出现「残留/错位/无限滚动」的竞态。
 * 3. 渲染与布局分离：整屏内容由调用方通过 `setRenderFn` 提供（返回已是带 ANSI 的最终文本），
 *    Screen 不关心行内语义与颜色，只负责「取尺寸 → 调回调 → 清屏 → 写整帧」。
 */
import type { Terminal } from "./terminal.js";

/** 渲染节流最小间隔（毫秒）。16ms ≈ 60fps 上限，去抖高频渲染请求。 */
const MIN_RENDER_INTERVAL_MS = 16;

/** 整屏内容生成函数：给定当前宽高，返回整屏每一行（已是带 ANSI 的最终文本）。 */
export type RenderFn = (width: number, height: number) => string[];

/** 输入透传回调：Screen 不实现编辑逻辑，只把原始 stdin 数据转交给调用方。 */
export type InputFn = (data: string) => void;

/**
 * 整屏渲染器：驱动一个 {@link Terminal} 做节流 + 幂等全量重绘。
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
   * 执行一次整屏绘制：幂等——先清屏再全量写当前帧。
   *
   * 因为每次都清屏重画，resize 连续触发也只会画出同一帧，绝不风暴。
   * 内容由 `renderFn` 生成，Screen 只负责拼成 `\r\n` 分隔的整帧并一次写出。
   */
  private doRender(): void {
    const width = this.terminal.columns;
    const height = this.terminal.rows;
    const lines = this.renderFn ? this.renderFn(width, height) : [];

    // 整帧以清屏开头，再逐行写出（行间 \r\n），可一次 write 完成。
    this.terminal.clearScreen();
    const buffer = lines.join("\r\n");
    this.terminal.write(buffer);
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
