/**
 * 权限卡请求生命周期（Phase C3）：一次 `askToolCall` 的 Promise / abort / 结算收口。
 *
 * 动机：`TuiApp` 既要管帧合成又要管输入路由，若把「Promise 结算 + AbortSignal 竞速 +
 * abort 监听摘除」也写在类里会很快撞上 ≤500 行上限。这里把这段**必 resolve** 的
 * 生命周期收敛成一个可单测的小对象，`TuiApp` 只提供开卡 / 结算的钩子。
 *
 * 不变量（硬约束：Esc/Ctrl+C 期间不得挂起）：`ask()` 返回的 Promise 一定会在
 * 按键裁决、signal abort 或 `dispose()` 之一发生时 resolve；`finish` 幂等。
 */
import {
  PermissionCard,
  type PermissionCardDecision,
  type PermissionCardInfo,
  type PermissionCardRenderOptions,
} from "./permission-card.js";

/** 卡片请求与宿主（TuiApp）的接线钩子。 */
export interface PermissionCardHost {
  /** 卡片激活：宿主把 confirm 模式压到栈顶。 */
  onOpen(): void;
  /** 卡片结算：宿主把 confirm 模式弹栈。 */
  onClose(): void;
  /** 需要重绘（开卡 / 结算，以及 abort 导致的结算）。 */
  onChange?(): void;
}

/**
 * 单张权限卡的生命周期：`ask` 起、`handleKey` / abort / `dispose` 止。
 */
export class PermissionCardRequest {
  /** 当前卡片；undefined 表示无请求在途。 */
  private card?: PermissionCard;
  /** 挂起 Promise 的结算函数。 */
  private settle?: (decision: PermissionCardDecision | null) => void;
  /** abort 监听（结算 / dispose 时摘除，避免泄漏）。 */
  private abortListener?: { signal: AbortSignal; handler: () => void };

  /**
   * @param host 开卡 / 结算钩子。
   */
  constructor(private readonly host: PermissionCardHost) {}

  /** @returns 是否有权限卡在途（TuiApp 据此决定是否同步弹出模式、是否独占按键）。 */
  get active(): boolean {
    return this.card !== undefined;
  }

  /** @returns 当前卡片（供 composer 渲染）；无请求时 undefined。 */
  get current(): PermissionCard | undefined {
    return this.card;
  }

  /**
   * 打开一张卡并等待裁决。
   *
   * @param info 工具名 / 摘要 / 可选 diff。
   * @param signal run 级中断信号（可选）；abort 时按 null 结算。
   * @returns 用户裁决；null 表示被中断（闸门按拒绝处理）。
   */
  ask(info: PermissionCardInfo, signal?: AbortSignal): Promise<PermissionCardDecision | null> {
    // 防御：异常时序下若上一张卡未结算，先按中断收口，避免 Promise 悬挂。
    this.finish(null);
    return new Promise((resolve) => {
      this.card = new PermissionCard(info);
      this.settle = resolve;
      this.host.onOpen();

      if (signal) {
        const handler = () => this.finish(null);
        if (signal.aborted) {
          handler();
        } else {
          signal.addEventListener("abort", handler, { once: true });
          this.abortListener = { signal, handler };
        }
      }
      this.host.onChange?.();
    });
  }

  /**
   * 把一次按键交给卡片；有裁决则立即结算。
   *
   * @param data 原始 stdin 输入。
   */
  handleKey(data: string): void {
    const decision = this.card?.handleKey(data);
    if (decision) this.finish(decision);
  }

  /**
   * 渲染当前卡片（composer 的合成槽调用）。
   *
   * @param options 宽度与高度预算。
   * @returns 卡片行；无请求时 undefined（调用方回退输入框）。
   */
  render(options: PermissionCardRenderOptions): string[] | undefined {
    return this.card?.render(options);
  }

  /**
   * 结算当前请求：弹栈、摘除 abort 监听并 resolve。
   *
   * 幂等：无请求在途时是 no-op（不触发宿主钩子）。
   *
   * @param decision 用户裁决；null 表示被中断。
   */
  finish(decision: PermissionCardDecision | null): void {
    const resolve = this.settle;
    const wasActive = this.card !== undefined;
    this.settle = undefined;
    this.card = undefined;
    if (this.abortListener) {
      this.abortListener.signal.removeEventListener("abort", this.abortListener.handler);
      this.abortListener = undefined;
    }
    if (!wasActive) return;
    this.host.onClose();
    resolve?.(decision);
    this.host.onChange?.();
  }

  /** 宿主停机时强制结算（resolve 为 null），保证没有悬挂的权限 Promise。 */
  dispose(): void {
    this.finish(null);
  }
}
