/**
 * 输入路由模式栈（Phase C2）。
 *
 * 改造前 `TuiApp.handleInput` 是一条 4 级 if 链：sessionPicker → 命令面板 → 文件面板
 * → editor 逐级 fall-through，且用输入前缀的字符串判断决定面板是否打开。层级
 * 一多就难以推理「某个键最终由谁消费」，全局键还会被 editor 提前吃掉。
 *
 * 本模块把它换成**模式栈**：
 * - editor 是常驻底栈模式（所有未消费输入最终落到它）；
 * - confirm / session-picker / palette / file-palette 是按压栈的弹出模式；
 * - `dispatch(data)` 从栈顶向下逐层询问 `handle(data)`，true 表示已消费、不再穿透；
 * - 全局键（ctrl+o / Shift+Tab / Esc / Ctrl+C）由 router 统一裁决，editor 不再优先消费。
 *
 * 具体模式（每个模式如何消费按键）由调用方（TuiApp）构造并注册，本模块只负责
 * 优先级、穿透与弹栈生命周期，因此可脱离真实终端单测。
 */
import { isEscapeKey, matchesKey } from "./keymap.js";

/** 模式 id：栈中每个模式唯一。 */
export type InputModeId = "confirm" | "session-picker" | "palette" | "file-palette" | "editor";

/**
 * 一个输入模式。
 *
 * `handle` 返回 true 表示按键已被本模式消费，router 不再向下穿透；返回 false 表示
 * 未处理，可继续交给下一层（例如 picker 收到可打印字符时不消费，让它落进 editor）。
 */
export interface InputMode {
  /** 模式 id（栈内唯一，重复 push 会替换旧实例）。 */
  id: InputModeId;
  /**
   * 消费一段原始输入。
   *
   * @param data 原始 stdin 输入。
   * @returns true = 已消费。
   */
  handle(data: string): boolean;
  /** 被弹栈时调用（清理模式私有状态，如清空输入框 / 记住 Esc 关闭）。 */
  onExit?(): void;
  /** 独占模式：顶栈时吞掉所有按键（含未识别的），不允许向下穿透。 */
  exclusive?: boolean;
}

/** 全局键动作：router 裁决全局键后回调宿主。 */
export interface InputRouterActions {
  /** Ctrl+O：展开 / 收起最近一个分组。 */
  onVerbose?(): void;
  /** Shift+Tab：循环权限模式。 */
  onModeCycle?(): void;
  /** PageUp：转录区向上滚动（到顶时回填一批历史）。 */
  onScrollUp?(): void;
  /** PageDown：转录区向下滚动（到底时回收一批回填）。 */
  onScrollDown?(): void;
  /** Ctrl+End：回到对话底部。 */
  onScrollBottom?(): void;
  /** Ctrl+C（无弹出模式时）：中断当前 run / 空闲退出。 */
  onInterrupt?(): void;
  /** Esc（无弹出模式时）：单次中断、双击识别为回退编辑手势。 */
  onEscape?(): void;
}

/**
 * 弹出模式集合：Esc / Ctrl+C 会先关闭它们，而不是触发全局中断。
 *
 * @param id 模式 id。
 * @returns 是否属于弹出模式。
 */
export function isTransientMode(id: InputModeId): boolean {
  return id === "session-picker" || id === "palette" || id === "file-palette";
}

/**
 * 输入路由模式栈。
 */
export class InputRouter {
  /** 模式栈：index 0 为底栈（editor），末位为栈顶（优先消费）。 */
  private readonly modes: InputMode[] = [];
  private readonly actions: InputRouterActions;

  /**
   * @param actions 全局键回调（缺省表示不处理，按键仍会被 router 吞掉）。
   */
  constructor(actions: InputRouterActions = {}) {
    this.actions = actions;
  }

  /**
   * 压入一个模式；同 id 的旧实例先移除（不触发 onExit）。
   *
   * @param mode 模式实例。
   */
  push(mode: InputMode): void {
    this.remove(mode.id);
    this.modes.push(mode);
  }

  /**
   * 弹出栈顶（或指定 id）的模式并触发其 onExit。
   *
   * @param id 指定要弹出的模式；缺省弹栈顶。
   * @returns 被弹出的模式；栈空 / 未命中返回 undefined。
   */
  pop(id?: InputModeId): InputMode | undefined {
    const index = id === undefined ? this.modes.length - 1 : this.modes.findIndex((mode) => mode.id === id);
    if (index < 0) return undefined;
    const [mode] = this.modes.splice(index, 1);
    mode.onExit?.();
    return mode;
  }

  /**
   * 移除模式但不触发 onExit（用于输入驱动的自动注销，如面板随输入消失）。
   *
   * @param id 模式 id。
   * @returns 是否移除成功。
   */
  remove(id: InputModeId): boolean {
    const index = this.modes.findIndex((mode) => mode.id === id);
    if (index < 0) return false;
    this.modes.splice(index, 1);
    return true;
  }

  /**
   * 让某个弹出模式与激活状态保持一致：激活则压栈（已存在则保持原实例），否则移除。
   *
   * 从 `TuiApp` 收编进路由：这是纯模式栈生命周期操作，与 `push` / `remove` 同属路由职责，
   * 放在这里也让「哪些模式该在栈上」的判断与栈实现同源。
   *
   * @param id 模式 id。
   * @param active 是否应处于栈中。
   * @param mode 模式实例（active=true 且未在栈上时用于压栈）。
   */
  setTransientMode(id: InputModeId, active: boolean, mode: InputMode): void {
    if (active) {
      if (!this.has(id)) this.push(mode);
      return;
    }
    this.remove(id);
  }

  /**
   * @param id 模式 id。
   * @returns 栈中是否存在该模式。
   */
  has(id: InputModeId): boolean {
    return this.modes.some((mode) => mode.id === id);
  }

  /**
   * @returns 当前栈顶模式；栈空返回 undefined。
   */
  top(): InputMode | undefined {
    return this.modes[this.modes.length - 1];
  }

  /** @returns 当前栈内模式 id 列表（底 → 顶），供测试与调试。 */
  stack(): InputModeId[] {
    return this.modes.map((mode) => mode.id);
  }

  /**
   * 分发一段原始输入。
   *
   * 裁决顺序：
   * 1. 独占顶栈（confirm）直接吞掉一切，绝不穿透；
   * 2. 全局键（Ctrl+C → 顶栈弹出模式先关闭，否则中断；Ctrl+O；Shift+Tab）；
   * 3. Esc：顶栈为弹出模式则关闭，否则走全局 Esc 手势；
   * 4. 自顶向下逐层 `handle`，未消费则落到底栈 editor。
   *
   * @param data 原始 stdin 输入。
   * @returns 是否被消费。
   */
  dispatch(data: string): boolean {
    if (data.length === 0) return false;
    const top = this.top();
    if (top?.exclusive) {
      top.handle(data);
      return true;
    }

    if (matchesKey("ctrl+c", data)) {
      const current = this.top();
      if (current && isTransientMode(current.id)) {
        this.pop();
        return true;
      }
      this.actions.onInterrupt?.();
      return true;
    }

    if (matchesKey("ctrl+o", data)) {
      this.actions.onVerbose?.();
      return true;
    }

    if (matchesKey("shift+tab", data)) {
      this.actions.onModeCycle?.();
      return true;
    }

    // C4：转录区滚动是全局键（editor 不消费 PageUp/PageDown），在模式穿透前裁决。
    if (matchesKey("pageup", data)) {
      this.actions.onScrollUp?.();
      return true;
    }
    if (matchesKey("pagedown", data)) {
      this.actions.onScrollDown?.();
      return true;
    }
    if (matchesKey("ctrl+end", data)) {
      this.actions.onScrollBottom?.();
      return true;
    }

    if (isEscapeKey(data)) {
      // 双击 Esc 是「回退编辑」手势：逐次交给宿主累积双击窗口判定。
      for (let i = 0; i < data.length; i += 1) {
        const current = this.top();
        if (current && isTransientMode(current.id)) {
          this.pop();
        } else {
          this.actions.onEscape?.();
        }
      }
      return true;
    }

    for (let i = this.modes.length - 1; i >= 0; i -= 1) {
      if (this.modes[i].handle(data)) return true;
    }
    return false;
  }
}
