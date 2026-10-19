/**
 * TUI 会话状态（Phase C1b · D5「状态收编」）。
 *
 * 旧实现把对话内容拆成 `TuiApp.contentLines` + `buffer` 两个追加式字段，折叠状态与
 * verbosity 散落在各个模块的模块级变量里。这里把**所有投影输入**收敛为一个对象：
 *
 * - `entries`：语义条目（来自 `StreamReducer`；TUI 宿主注入的 notice 也在同一条流里，
 *   保证 slash 输出 / 欢迎头与工具事件严格按时间顺序排列）；
 * - `verbosity`：三档分类旋钮（low / medium / high）；
 * - `expanded`：用户显式切换过的组展开状态（key = 组首叶子 id + kind）；
 * - `toasts`：C3 的 Toast 队列（瞬时提示的唯一可变状态；渲染槽由 `TuiApp.buildFrame` 合成）。
 *
 * 状态本身**不写终端**：任何变更只通过 `subscribe` 通知宿主
 * （`TuiApp` 把它接到 `requestRender`），因此没有模块级可变全局，也不会产生 ANSI。
 *
 * 权限卡状态（C3）不属于本容器：它是「一次 ask 的生命周期」，由 `TuiApp` 就近持有，
 * 卡片 settle 即销毁，无需跨帧保留。
 */
import { ToastQueue } from "./toast.js";
import type { TuiEntry, TuiEntryMeta, TuiVerbosity } from "../stream/entries.js";

/** Toast 相关类型从 `toast.ts` 统一导出，避免两处重复定义。 */
export type { ToastEntry as TuiToast, ToastInput as TuiToastInput } from "./toast.js";

/**
 * TUI 订阅的窄接口：`PrintPresenter` 天然满足。
 *
 * 之所以不直接依赖 presenter 类：`TuiState` 只关心「读条目 + 订阅变更」，
 * 测试可以注入任意假实现；`appendNotice` 可选，宿主未提供时退化为本地 notice。
 */
export interface TuiEntrySource {
  /** 当前条目序列（实时引用；追加 / 补丁会就地更新）。 */
  entries(): readonly TuiEntry[];
  /** 订阅任意归约变更；返回取消订阅函数。 */
  subscribe(fn: () => void): () => void;
  /**
   * 可选：把宿主文本（欢迎头 / slash 输出）作为 notice 追加到同一归约流。
   *
   * 提供该入口时，TUI 的 notice 与 reducer 条目共享顺序与 reset 生命周期；
   * 未提供时由 {@link TuiState.appendNotice} 落入本地数组（主要用于单测）。
   */
  appendNotice?(text: string, options?: { rawAnsi?: boolean }): void;
  /**
   * 可选：把用户输入回显作为 `user` 条目追加到同一归约流（M3）。
   *
   * 与 `appendNotice` 相同的可选契约：提供时用户输入以语义条目进入 TUI 对话流；
   * 未提供时由 {@link TuiState.appendUser} 落入本地数组（主要用于单测）。
   */
  appendUser?(text: string): void;
}

/**
 * 整屏 TUI 的唯一可变状态容器。
 *
 * 生命周期：`TuiApp` 构造时创建，`attachSource` 后 entry 序列由 presenter 持有；
 * `reset` 由 reducer 的 `reset` 变更经订阅自动反映，无需 TUI 额外清理。
 */
export class TuiState {
  /** 三档 verbosity（TUI 默认 medium，对齐 opencode 的生产默认值）。 */
  verbosity: TuiVerbosity = "medium";

  /** 用户显式切换过的组展开状态；缺省值由 `rows.isGroupExpanded` 决定。 */
  readonly expanded = new Map<string, boolean>();

  /** C3 Toast 队列：瞬时提示的唯一可变状态（渲染槽由 TuiApp 合成，D8）。 */
  readonly toasts = new ToastQueue(() => this.notify());

  /** C4：可见窗口底边距挂载区底边的行数（0 = 贴底）。 */
  historyOffset = 0;

  /** C4：可见预算之外额外挂载的行数（PageUp 到顶时增长，回到底部时回收）。 */
  backfill = 0;

  /** 变更订阅者（TuiApp 在这里接 requestRender）。 */
  private readonly listeners = new Set<() => void>();
  /** 未接 presenter 时的本地 notice（主要服务单测 / 首帧欢迎头）。 */
  private readonly localEntries: TuiEntry[] = [];
  /** 本地 notice 的自增序号，避免与 reducer 的 `${kind}-${n}` id 冲突。 */
  private localSeq = 0;
  /** 当前接入的条目源（presenter）；undefined 表示使用本地 notice。 */
  private source?: TuiEntrySource;
  /** presenter 订阅的取消函数（重复 attach 时先解绑）。 */
  private detachSource?: () => void;

  /**
   * 当前条目序列：接源时读源，否则读本地 notice。
   *
   * @returns 只读条目序列（条目本身是实时引用）。
   */
  entries(): readonly TuiEntry[] {
    return this.source?.entries() ?? this.localEntries;
  }

  /**
   * 接入条目源并订阅其变更。
   *
   * 重复调用会先解绑旧源；新源接入后立即通知一次，让首帧拿到已有条目
   * （例如 `--resume` 后 presenter 里已经回放的历史）。
   *
   * @param source 条目源（通常为 `PrintPresenter`）。
   */
  attachSource(source: TuiEntrySource): void {
    this.detach();
    this.source = source;
    this.detachSource = source.subscribe(() => this.notify());
    this.notify();
  }

  /** 解除当前条目源（TUI stop / 测试清理）；本地 notice 保留不变。 */
  detach(): void {
    this.detachSource?.();
    this.detachSource = undefined;
    this.source = undefined;
  }

  /**
   * 追加一段宿主文本为 notice 条目（`append` 的内部实现）。
   *
   * 文本按 `\n` 固化：每个非尾部空段一条 notice；`rawAnsi` 时投影层原样输出，
   * 保证欢迎头 / slash 输出的颜色不丢。接源时委托给 presenter，保证与 reducer
   * 条目共享顺序与 reset 生命周期。
   *
   * @param text 待追加文本（可含多行与 ANSI）。
   * @param options `rawAnsi=true` 表示原样透传 ANSI。
   */
  appendNotice(text: string, options?: { rawAnsi?: boolean }): void {
    if (text.length === 0) return;
    if (this.source?.appendNotice) {
      this.source.appendNotice(text, options);
      return;
    }
    const lines = text.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      this.localEntries.push({
        id: `notice-local-${this.localSeq}`,
        kind: "notice",
        status: "done",
        text: line,
        ...(options?.rawAnsi ? { meta: { rawAnsi: true } satisfies TuiEntryMeta } : {}),
      });
      this.localSeq += 1;
    }
    this.notify();
  }

  /**
   * 切换 verbosity；同值不通知（避免无意义重绘）。
   *
   * @param level 目标档位。
   */
  setVerbosity(level: TuiVerbosity): void {
    if (this.verbosity === level) return;
    this.verbosity = level;
    this.notify();
  }

  /**
   * 追加一条用户输入回显为 `user` 条目（M3）。
   *
   * 接源时委托给 presenter，保证与 reducer 条目共享顺序与 reset 生命周期；
   * 未接源时落入本地数组（与 {@link appendNotice} 的降级策略一致，主要服务单测）。
   *
   * @param text 用户输入原文（未上色）。
   */
  appendUser(text: string): void {
    if (text.length === 0) return;
    if (this.source?.appendUser) {
      this.source.appendUser(text);
      return;
    }
    this.localEntries.push({ id: `user-local-${this.localSeq}`, kind: "user", status: "done", text });
    this.localSeq += 1;
    this.notify();
  }

  /**
   * 会话级视图重置（M2）：清空展开状态、滚动归零并清空 toast。
   *
   * 为什么要整体重置：`expanded` / 滚动状态是「上一个会话的视图」，切到新会话后
   * 旧 key 可能命中新会话条目（组 ID = 首叶子 id + kind），导致新条目莫名展开或
   * 视图停在旧位置。会话切换（/clear、/resume、fork）时由 TuiApp 调用。
   */
  resetView(): void {
    this.expanded.clear();
    this.historyOffset = 0;
    this.backfill = 0;
    this.toasts.clear();
    this.notify();
  }

  /**
   * 写入某个组的展开状态并请求重绘。
   *
   * @param id 组 ID（{@link groupID}）。
   * @param expanded true 展开、false 折叠。
   */
  setExpanded(id: string, expanded: boolean): void {
    if (this.expanded.get(id) === expanded) return;
    this.expanded.set(id, expanded);
    this.notify();
  }

  /**
   * 写入滚动状态并请求重绘（C4）。
   *
   * 只保存原始值；越界由每帧的 `mountTranscript` 夹紧到 `maxOffset`，因为最大可滚动
   * 距离依赖宽度 / verbosity / 展开状态，不是状态容器自身能静态判断的。
   *
   * @param historyOffset 可见窗口底边距挂载区底边的行数（0 = 贴底）。
   * @param backfill 可见预算之外额外挂载的行数。
   */
  setScroll(historyOffset: number, backfill: number): void {
    const nextOffset = Math.max(0, Math.floor(historyOffset));
    const nextBackfill = Math.max(0, Math.floor(backfill));
    if (this.historyOffset === nextOffset && this.backfill === nextBackfill) return;
    this.historyOffset = nextOffset;
    this.backfill = nextBackfill;
    this.notify();
  }

  /**
   * 订阅状态变更（`onChange → requestRender` 的接线点）。
   *
   * @param fn 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 广播一次变更（所有状态写入路径的唯一出口）。 */
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
