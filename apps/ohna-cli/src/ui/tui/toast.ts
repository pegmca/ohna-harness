/**
 * Toast 队列（Phase C3 · D8「合成槽」）。
 *
 * 参考自 opencode `packages/tui/src/ui/toast.tsx`（MIT，Copyright (c) 2025 opencode）。
 * 取舍：opencode 用 SolidJS store + 绝对定位浮层 + 鼠标 hover 暂停；ohna 是全帧同步测量的
 * 整屏模型（D8），没有浮层 / zIndex / 鼠标，因此这里只移植**队列语义与可暂停计时器**：
 * - 显示中且未暂停且无排队 → 新 toast 直接替换（避免瞬时提示排队延迟）；
 * - 否则入队（暂停时也入队，鼠标 hover 语义在 TUI 下由显式 pause/resume 承担）；
 * - 超时后弹出队首并继续显示下一条；仍有排队时渲染 `+N more`。
 *
 * 本模块**零依赖、不读终端**：当前条与排队条数由 `TuiApp.buildFrame` 取走渲染，
 * 变更通过 `onChange` 通知宿主重绘（与 `TuiState` 的 `onChange → requestRender` 一致）。
 */

/** toast 上的可执行动作（opencode `action` 语义；TUI 暂无鼠标，保留给键位/命令触发）。 */
export interface ToastAction {
  /** 按钮文案。 */
  label: string;
  /** 触发动作。 */
  run(): void;
}

/** 一条进入队列的 toast（duration 已补默认值）。 */
export interface ToastEntry {
  /** 展示文本（可含 ANSI：调用方自行着色）。 */
  text: string;
  /** 展示时长（毫秒）。 */
  duration: number;
  /** 可选动作。 */
  action?: ToastAction;
}

/** `push` 的入参（duration 可省略）。 */
export interface ToastInput {
  /** 展示文本（可含 ANSI）。 */
  text: string;
  /** 展示时长；缺省 {@link DEFAULT_TOAST_DURATION_MS}。 */
  duration?: number;
  /** 可选动作。 */
  action?: ToastAction;
}

/** 默认展示时长（对齐 opencode 的 5s）。 */
export const DEFAULT_TOAST_DURATION_MS = 5_000;

/**
 * 把当前 toast 渲染成单行文本（含排队计数）。
 *
 * 合成槽只有 1 行：排队计数以 `+N more` 追加在同一行尾，而不是再占一行（D8）。
 *
 * @param entry 当前 toast。
 * @param pending 排队条数（>=0）。
 * @returns 单行文本。
 */
export function formatToastLine(entry: ToastEntry, pending: number): string {
  return pending > 0 ? `${entry.text}  +${pending} more` : entry.text;
}

/**
 * Toast 队列：当前条（`slots[0]`）+ 排队条（其余）。
 *
 * 计时器只服务当前条；`pause` 保存剩余时长，`resume` 从剩余时长继续。
 */
export class ToastQueue {
  /** 当前条 + 排队条；index 0 为屏幕显示中的那一条。 */
  private readonly slots: ToastEntry[] = [];
  /** 是否处于暂停（暂停时新 toast 一律入队，且计时器不再推进）。 */
  private paused = false;
  /** 当前条的计时器句柄。 */
  private timer: NodeJS.Timeout | null = null;
  /** 当前条本次计时的起点。 */
  private startedAt = 0;
  /** 当前条剩余时长（毫秒）。 */
  private remaining = 0;

  /**
   * @param onChange 任何队列变更（push / 超时 / resume）后的重绘回调。
   */
  constructor(private readonly onChange?: () => void) {}

  /** @returns 当前显示中的 toast；队列为空返回 undefined。 */
  get current(): ToastEntry | undefined {
    return this.slots[0];
  }

  /** @returns 排队等待显示的条数（不含当前条）。 */
  get pending(): number {
    return Math.max(0, this.slots.length - 1);
  }

  /**
   * 入队一条 toast：显示中且未暂停且无排队时直接替换，否则排到队尾。
   *
   * @param input 文本 / 时长 / 可选动作。
   */
  push(input: ToastInput): void {
    const entry: ToastEntry = {
      text: input.text,
      duration: input.duration ?? DEFAULT_TOAST_DURATION_MS,
      ...(input.action ? { action: input.action } : {}),
    };

    // 显示中且（暂停 或 已有排队）→ 不打断当前条，排到队尾；否则直接替换 / 立即显示。
    if (this.current && (this.paused || this.slots.length > 1)) {
      this.slots.push(entry);
      this.notify();
      return;
    }
    if (this.current) {
      this.slots[0] = entry;
    } else {
      this.slots.push(entry);
    }
    this.start(entry.duration);
    this.notify();
  }

  /**
   * 弹出当前条并显示下一条；队列清空时退出暂停态。
   *
   * 超时回调与显式调用共用本方法。
   */
  dismiss(): void {
    this.clearTimer();
    this.slots.shift();
    const next = this.slots[0];
    if (!next) {
      this.paused = false;
      this.notify();
      return;
    }
    this.remaining = next.duration;
    if (!this.paused) this.start(next.duration);
    this.notify();
  }

  /**
   * 暂停计时器（剩余时长被保存，`resume` 后继续）。无当前条或已暂停时无操作。
   *
   * 用途（M5）：权限卡激活时由 `TuiApp` 调用，冻结正在显示的提示，避免用户在
   * 决策期间被计时器吞掉提示；卡片结算后 `resume`。opencode 用鼠标 hover 承担同一语义，
   * ohna 无鼠标，改由「确认态」这一明确的交互边界触发。
   */
  pause(): void {
    if (!this.current || this.paused) return;
    this.paused = true;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    this.clearTimer();
  }

  /** 从剩余时长继续计时。无当前条或未暂停时无操作。 */
  resume(): void {
    if (!this.current || !this.paused) return;
    this.paused = false;
    this.start(this.remaining);
    this.notify();
  }

  /**
   * 清空全部 toast（当前条 + 排队）并停止计时器、退出暂停态。
   *
   * 会话切换（M2）时由 `TuiState.resetView` 调用：旧会话的提示不应残留到新会话。
   */
  clear(): void {
    if (this.slots.length === 0) return;
    this.slots.length = 0;
    this.clearTimer();
    this.paused = false;
    this.remaining = 0;
    this.notify();
  }

  /** 释放计时器（TUI stop 时调用，避免进程退出被未清除的 timer 拖住）。 */
  dispose(): void {
    this.clearTimer();
  }

  /**
   * 启动当前条计时器。
   *
   * @param duration 本次计时时长（含 resume 的剩余时长）。
   */
  private start(duration: number): void {
    this.clearTimer();
    this.remaining = duration;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dismiss();
    }, duration);
    // 不阻止进程退出（对齐 opencode 的 `.unref()`）。
    this.timer.unref?.();
  }

  /** 清除计时器句柄。 */
  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** 广播一次变更给宿主。 */
  private notify(): void {
    this.onChange?.();
  }
}
