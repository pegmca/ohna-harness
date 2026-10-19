/**
 * 长会话挂载预算（Phase C4）。
 *
 * 概念移植 opencode `packages/tui/src/routes/session/mount-budget.ts`（MIT）：
 * 转录区的挂载预算按**条目权重**而不是真实行数计——折叠组恒 1 行，所以同样的预算
 * 能容纳更多对话深度。opencode 需要 afterLayout 补偿滚动；ohna 是全帧同步投影模型，
 * 每帧都能直接测量真实行数，因此这里只需「先按权重选挂载起点，再按真实行切片」。
 *
 * 滚动模型（三者的关系）：
 * - `backfill`：在可见预算之外**额外挂载**的行数；PageUp 到顶时按 {@link BACKFILL_CHUNK}
 *   增长，PageDown 回到底部时回收一批。
 * - `historyOffset`：可见窗口底边距挂载区底边的行数；0 = 贴底（toBottom）。
 * - 回填会让挂载区在**前部**变长；`nextScroll` 只把 offset 增加一页（而不是整批新增行数），
 *   因此视图按 PageUp 的正常步长向上移动，不会从旧内容顶端瞬移到新挂载区顶端。
 */
import type { TuiEntry, TuiVerbosity } from "../stream/entries.js";
import { entryPath, type GroupKind } from "./classifier.js";
import { groupEntries, type GroupNode } from "./grouping.js";
import { projectNodeRows, rowWeight } from "./rows.js";

/** 初始保留在可见区上方的尾部行数（让 PageUp 第一下就有内容可滚）。 */
export const TRANSCRIPT_TAIL_ROWS = 40;

/** 到顶后每次向上回填 / 回到底部时每次回收的行数。 */
export const BACKFILL_CHUNK = 60;

/**
 * 按当前 verbosity 把条目归约成分组树（挂载预算的输入）。
 *
 * @param entries 语义条目序列。
 * @param verbosity 三档分类旋钮。
 * @returns 分组树根节点序列。
 */
export function buildTranscriptNodes(
  entries: readonly TuiEntry[],
  verbosity: TuiVerbosity,
): readonly GroupNode<TuiEntry, GroupKind>[] {
  return groupEntries(entries, (entry) => entryPath(entry, verbosity));
}

/** {@link mountTranscript} 的输入。 */
export interface TranscriptMountInput {
  /** 已构建的分组树（通常来自 {@link buildTranscriptNodes}）。 */
  nodes: readonly GroupNode<TuiEntry, GroupKind>[];
  /** verbosity（决定分组是否摊平 / 默认展开）。 */
  verbosity: TuiVerbosity;
  /** 用户显式展开状态。 */
  expanded: ReadonlyMap<string, boolean>;
  /** 终端列数（投影截断基准）。 */
  width: number;
  /** 对话区可见行预算（终端高度扣除输入区 / 面板 / 状态行 / toast）。 */
  budget: number;
  /** 可见预算之外额外挂载的行数（≥0）。 */
  backfill: number;
  /** 可见窗口底边距挂载区底边的行数（≥0，0 = 贴底）。 */
  historyOffset: number;
}

/** {@link mountTranscript} 的结果。 */
export interface TranscriptMount {
  /** 可见行（≤ budget，按真实行从挂载区尾部偏移切片）。 */
  lines: string[];
  /** 可见窗口上方未显示的条目数（状态行「↑ 历史 N 条」）。 */
  hiddenEntries: number;
  /** 允许的最大 historyOffset（挂载区行数 - budget）。 */
  maxOffset: number;
  /** 更上方是否还有未挂载的顶层节点（还能继续回填）。 */
  hasMore: boolean;
  /** 当前挂载区的真实行数（测试 / 调试用）。 */
  mountedRows: number;
}

/** {@link nextScroll} 的滚动方向。 */
export type ScrollDirection = "up" | "down" | "bottom";

/** {@link nextScroll} 的输入：挂载上下文 + 方向。 */
export interface ScrollInput extends TranscriptMountInput {
  /** 滚动方向；`bottom` 等价于 session.toBottom。 */
  direction: ScrollDirection;
}

/**
 * 计算可见窗口：先按权重选挂载起点，再按真实行从尾部对齐切片。
 *
 * 两阶段的原因：权重是「条目行」概念（折叠组 = 1），用于快速决定要挂载多少节点；
 * 但单条 entry 可能渲染多行，所以最终可见区必须用真实投影行数切片（多挂的节点
 * 只是多占一点内存，不会让窗口越过终端高度）。
 *
 * @param input 分组树 / 宽度 / 预算 / 滚动状态。
 * @returns 可见行、隐藏条目数与滚动边界。
 */
export function mountTranscript(input: TranscriptMountInput): TranscriptMount {
  const { nodes, verbosity, expanded, width } = input;
  const budget = Math.max(0, Math.floor(input.budget));
  const mountedBudget = budget + TRANSCRIPT_TAIL_ROWS + Math.max(0, Math.floor(input.backfill));
  const options = { verbosity, expanded, width };

  // 阶段 1：按权重从尾部累计，确定挂载起点。
  const weights = nodes.map((node) => rowWeight(node, verbosity, expanded));
  let start = nodes.length;
  let spent = 0;
  while (start > 0 && spent < mountedBudget) {
    start -= 1;
    spent += weights[start];
  }

  /** 从 `from` 起逐节点投影，同时记录每个顶层节点的真实行数。 */
  const projectFrom = (from: number): { lines: string[]; counts: number[] } => {
    const lines: string[] = [];
    const counts: number[] = [];
    for (let index = from; index < nodes.length; index += 1) {
      const part = projectNodeRows([nodes[index]], options);
      lines.push(...part);
      counts.push(part.length);
    }
    return { lines, counts };
  };

  let projected = projectFrom(start);
  // 阶段 2：权重是下界时真实行可能不足预算（例如空 entry 权重 1 但渲染 0 行），
  // 按块向上补挂，保证有历史的会话能填满可见区。
  while (start > 0 && projected.lines.length < mountedBudget) {
    start = Math.max(0, start - 16);
    projected = projectFrom(start);
  }

  const mountedRows = projected.lines.length;
  const maxOffset = Math.max(0, mountedRows - budget);
  const offset = Math.min(Math.max(0, Math.floor(input.historyOffset)), maxOffset);
  const end = mountedRows - offset;
  const startRow = Math.max(0, end - budget);
  const lines = projected.lines.slice(startRow, end);

  // 可见窗口上方隐藏的条目数：未挂载节点 + 挂载区内位于可见起点之前的节点。
  let hiddenEntries = 0;
  if (lines.length > 0) {
    let acc = 0;
    let firstVisible = projected.counts.length;
    for (let index = 0; index < projected.counts.length; index += 1) {
      if (acc + projected.counts[index] > startRow) {
        firstVisible = index;
        break;
      }
      acc += projected.counts[index];
    }
    for (let index = 0; index < start + firstVisible; index += 1) hiddenEntries += nodes[index].size;
  }

  return { lines, hiddenEntries, maxOffset, hasMore: start > 0, mountedRows };
}

/**
 * 计算一次滚动后的状态（PageUp / PageDown / toBottom）。
 *
 * - `up`：优先在挂载区内上移半页；已在顶部且还有未挂载节点时回填一批，再继续上移
 *   半页（回填只扩大可滚范围，不改变滚动步长，因此不会跳变）。
 * - `down`：先向下移半页；已在底部时回收一批回填（减少内存，不改变贴底可见内容）。
 * - `bottom`：直接贴底。
 *
 * @param input 当前挂载上下文与滚动方向。
 * @returns 新的 `historyOffset` / `backfill`。
 */
export function nextScroll(input: ScrollInput): { historyOffset: number; backfill: number } {
  const current = {
    historyOffset: Math.max(0, Math.floor(input.historyOffset)),
    backfill: Math.max(0, Math.floor(input.backfill)),
  };
  if (input.direction === "bottom") return { historyOffset: 0, backfill: current.backfill };

  const budget = Math.max(0, Math.floor(input.budget));
  const page = Math.max(1, Math.floor(budget / 2));
  const mount = mountTranscript(input);

  if (input.direction === "up") {
    if (current.historyOffset < mount.maxOffset) {
      return {
        historyOffset: Math.min(mount.maxOffset, current.historyOffset + page),
        backfill: current.backfill,
      };
    }
    if (!mount.hasMore) return current;
    const backfill = current.backfill + BACKFILL_CHUNK;
    // 新增行都在挂载区前部：offset 仍只增加一页，视图按正常步长上移；
    // 若按「新增行数」增加 offset，会直接跳到新挂载区顶端，越过中间内容。
    const grown = mountTranscript({ ...input, backfill, historyOffset: current.historyOffset });
    return {
      historyOffset: Math.min(grown.maxOffset, current.historyOffset + page),
      backfill,
    };
  }

  // down
  if (current.historyOffset > 0) {
    return { historyOffset: Math.max(0, current.historyOffset - page), backfill: current.backfill };
  }
  if (current.backfill > 0) {
    return { historyOffset: 0, backfill: Math.max(0, current.backfill - BACKFILL_CHUNK) };
  }
  return { historyOffset: 0, backfill: 0 };
}
