/**
 * 转录区桥接（Phase C4）：把 `TuiState` 的投影参数接到挂载预算纯函数上。
 *
 * 为什么单独成模块：`tui-app.ts` 已是整屏编排的壳（输入路由 / 合成槽 / 生命周期），
 * 再塞入「预算切片 + 历史计数 + 滚动状态回写」会突破 500 行纪律。这里只做**无副作用
 * 的组合**：读条目与滚动状态 → 调用 `mount.ts` → 返回可见行 / 新滚动状态。
 *
 * 结构类型而非 `import { TuiState }`：避免桥接层反向依赖状态容器，单测可用最小假对象。
 */
import type { TuiEntry, TuiVerbosity } from "../stream/entries.js";
import { buildTranscriptNodes, mountTranscript, nextScroll, type ScrollDirection } from "./mount.js";
import type { TuiStatus } from "./panels.js";

/** 投影所需的条目与渲染参数。 */
export interface TranscriptViewInput {
  /** 当前语义条目序列。 */
  entries: readonly TuiEntry[];
  /** 三档 verbosity。 */
  verbosity: TuiVerbosity;
  /** 用户展开状态。 */
  expanded: ReadonlyMap<string, boolean>;
  /** 终端列数。 */
  width: number;
  /** 对话区可见行预算。 */
  budget: number;
  /** 额外挂载行数。 */
  backfill: number;
  /** 可见窗口底边距挂载区底边的行数。 */
  historyOffset: number;
}

/** 投影结果：可见行 + 已合并历史提示的状态行数据。 */
export interface TranscriptView {
  /** 可见对话行（≤ budget）。 */
  lines: string[];
  /** 宿主状态；有隐藏历史时补上 `historyAbove`。 */
  status: TuiStatus | undefined;
}

/**
 * 计算一帧的转录区可见行，并把「↑ 历史 N 条」并入状态行数据。
 *
 * 不改宿主的 `statusFn`：`TuiStatus` 是每帧求值的快照，这里只做一次浅合并。
 *
 * @param input 条目 / 宽度 / 预算 / 滚动状态。
 * @param status 宿主提供的状态行快照（可选）。
 * @returns 可见行与合并后的状态。
 */
export function transcriptView(input: TranscriptViewInput, status?: TuiStatus): TranscriptView {
  const mount = mountTranscript({
    nodes: buildTranscriptNodes(input.entries, input.verbosity),
    verbosity: input.verbosity,
    expanded: input.expanded,
    width: input.width,
    budget: input.budget,
    backfill: input.backfill,
    historyOffset: input.historyOffset,
  });
  const merged =
    status && mount.hiddenEntries > 0 ? { ...status, historyAbove: mount.hiddenEntries } : status;
  return { lines: mount.lines, status: merged };
}

/**
 * TUI 状态容器中滚动所需的最小结构（`TuiState` 天然满足）。
 */
export interface ScrollableState {
  /** 当前条目序列。 */
  entries(): readonly TuiEntry[];
  /** 三档 verbosity。 */
  verbosity: TuiVerbosity;
  /** 用户展开状态。 */
  expanded: ReadonlyMap<string, boolean>;
  /** 当前额外挂载行数。 */
  backfill: number;
  /** 当前滚动偏移。 */
  historyOffset: number;
  /**
   * 写回滚动状态。
   *
   * @param historyOffset 新的滚动偏移。
   * @param backfill 新的额外挂载行数。
   */
  setScroll(historyOffset: number, backfill: number): void;
}

/**
 * 按方向滚动转录区并写回状态容器。
 *
 * @param state 可滚动的状态容器。
 * @param size 终端列数与对话区行预算。
 * @param direction `up` / `down` / `bottom`。
 */
export function scrollState(
  state: ScrollableState,
  size: { width: number; budget: number },
  direction: ScrollDirection,
): void {
  const next = nextScroll({
    nodes: buildTranscriptNodes(state.entries(), state.verbosity),
    verbosity: state.verbosity,
    expanded: state.expanded,
    width: size.width,
    budget: size.budget,
    backfill: state.backfill,
    historyOffset: state.historyOffset,
    direction,
  });
  state.setScroll(next.historyOffset, next.backfill);
}
