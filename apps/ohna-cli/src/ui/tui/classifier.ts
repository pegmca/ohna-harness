/**
 * 条目分类规则（Phase C1b）。
 *
 * 参考自 opencode `packages/tui/src/routes/session/grouping/session.ts` 的
 * `partPath` 与 `activity-summary.ts` 的 `activitySummary` / `busyLabel`（MIT）。
 *
 * 适配差异：
 * - opencode 有 instructions / question 等特殊条目；ohna 只有 user / assistant /
 *   reasoning / tool / error / notice 六类，因此起步只保留三类分组：
 *   `reasoning` / `exploration` / `activity`；
 * - ohna 工具表更小：read / grep / find / ls 属探索（只读），bash / write / edit
 *   属活动（有副作用）；未知工具保守归入 activity；
 * - 文本条目（user / assistant / error / notice）永远独立成行，不参与分组。
 *
 * 本模块是**纯函数层**：不读终端宽度、不产 ANSI、不缓存状态。
 */
import type { TuiEntry, TuiVerbosity } from "../stream/entries.js";
import type { GroupNode } from "./grouping.js";

/** 分组维度：思考、探索（只读工具）、活动（有副作用工具）。 */
export type GroupKind = "reasoning" | "exploration" | "activity";

/** 只读探索工具：不修改工作区，可安全折叠成「N reads / N searches」摘要。 */
export const EXPLORATION_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** activity 摘要的计数桶。 */
interface ActivityCounts {
  command: number;
  edit: number;
  thought: number;
  read: number;
  tool: number;
}

/**
 * 判断工具是否属于探索类（只读）。
 *
 * @param toolName 工具名（大小写不敏感）。
 * @returns 属于 read / grep / find / ls 时返回 true。
 */
export function isExplorationTool(toolName: string): boolean {
  return EXPLORATION_TOOLS.has(toolName.toLowerCase());
}

/**
 * 单条 entry 的基础分组 kind（不考虑 verbosity）。
 *
 * 文本条目返回 undefined（独立成行）；工具按 ohna 工具表分到 exploration / activity；
 * thinking 归 reasoning。
 *
 * @param entry 语义条目。
 * @returns 基础分组 kind；文本条目返回 undefined。
 */
export function entryGroupKind(entry: TuiEntry): GroupKind | undefined {
  if (entry.kind === "reasoning") return "reasoning";
  if (entry.kind === "tool") {
    const name = entry.meta?.toolName ?? "";
    return isExplorationTool(name) ? "exploration" : "activity";
  }
  return undefined;
}

/**
 * 求一条 entry 的分组路径（移植 opencode `partPath` 的相邻合并语义）。
 *
 * verbosity 语义（D6）：
 * - `low`：所有非文本条目统一走 `["activity"]`，整段工具 / 思考折叠为一行摘要；
 * - `medium` / `high`：thinking → reasoning，只读工具 → exploration，其余工具 → activity。
 *
 * `medium` / `high` 下 activity 组由投影层「摊平」逐条渲染（见 `rows.ts`），
 * 因此这里仍返回 `["activity"]`，保持分类规则单一来源。
 *
 * @param entry 语义条目。
 * @param verbosity 当前档位。
 * @returns 分组路径；空数组表示独立叶子。
 */
export function entryPath(entry: TuiEntry, verbosity: TuiVerbosity): GroupKind[] {
  const kind = entryGroupKind(entry);
  if (!kind) return [];
  if (verbosity === "low") return ["activity"];
  return [kind];
}

/** activity 摘要结果：`label` 用于折叠组头，`active` 表示仍有运行中条目。 */
export interface ActivitySummary {
  /** 已完成条目的计数摘要，如 `"3 commands, 1 edit, 2 thoughts, 4 reads"`。 */
  label: string;
  /** 子树中是否还有 running / streaming 条目（折叠组头据此显示 spinner）。 */
  active: boolean;
}

/**
 * 判断条目是否仍在进行中。
 *
 * 只把 `streaming` / `running` 视为未完成；`error` 是已结束的终态，会计入摘要
 * （失败的工具调用同样消耗了用户的时间，应当可见）。
 *
 * @param entry 语义条目。
 * @returns 仍在进行中时返回 true。
 */
function isActive(entry: TuiEntry): boolean {
  return entry.status === "streaming" || entry.status === "running";
}

/**
 * 运行中条目的稳定状态文案（移植 opencode `busyLabel`）。
 *
 * 文案只依赖工具名 / 条目类型，不依赖流式内容，因此不会随参数陆续到达而闪烁。
 *
 * @param entry 进行中的条目。
 * @returns 如 `"Running bash…"` / `"Thinking…"`；条目已结束返回空串。
 */
export function busyLabel(entry: TuiEntry): string {
  if (!isActive(entry)) return "";
  if (entry.kind === "reasoning" || entry.kind === "assistant") return "Thinking…";
  if (entry.kind === "tool") return `Running ${entry.meta?.toolName || "tool"}…`;
  return "";
}

/**
 * 统计一组叶子条目的活动摘要（移植 opencode `activitySummary`）。
 *
 * 只统计**已完成**条目；仍有运行中条目时 `active=true`，调用方可以用
 * {@link busyLabel} 在没有任何已完成计数时显示 `Running bash…`，避免摘要闪烁。
 *
 * 计数规则与 ohna 工具表对齐：
 * - bash → command；write / edit → edit；read / grep / find / ls → read；其他 → tool；
 * - reasoning 且有正文 → thought（空的思考块不计，避免「0 thoughts」噪声）。
 *
 * @param entries 组内叶子条目（顺序不影响计数）。
 * @returns 摘要标签与 active 标记。
 */
export function activitySummary(entries: readonly TuiEntry[]): ActivitySummary {
  const counts: ActivityCounts = { command: 0, edit: 0, thought: 0, read: 0, tool: 0 };
  let active = false;

  for (const entry of entries) {
    if (isActive(entry)) {
      active = true;
      continue;
    }
    if (entry.kind === "reasoning") {
      if (entry.text.trim()) counts.thought += 1;
      continue;
    }
    if (entry.kind !== "tool") continue;

    const name = (entry.meta?.toolName ?? "").toLowerCase();
    if (name === "bash") counts.command += 1;
    else if (name === "write" || name === "edit") counts.edit += 1;
    else if (EXPLORATION_TOOLS.has(name)) counts.read += 1;
    else counts.tool += 1;
  }

  const label = (Object.entries(counts) as [keyof ActivityCounts, number][])
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
    .join(", ");

  return { label, active };
}

/**
 * 求一组条目的首条进行中文案（供折叠组头在无已完成计数时显示）。
 *
 * @param entries 组内叶子条目。
 * @returns 首个进行中条目的 busyLabel；没有则返回空串。
 */
export function firstBusyLabel(entries: readonly TuiEntry[]): string {
  for (const entry of entries) {
    const label = busyLabel(entry);
    if (label) return label;
  }
  return "";
}

/**
 * 收集子树下的全部叶子条目（分组树 → 平面数组）。
 *
 * 之所以放在分类模块而不是 `rows.ts`：摘要计算只需要「一组叶子」，
 * 不依赖宽度 / 颜色 / 展开状态，保持投影层只做排版。
 *
 * @param node 分组树节点序列。
 * @returns 深度优先顺序的叶子条目。
 */
export function collectLeaves<Entry>(nodes: readonly GroupNode<Entry, GroupKind>[]): Entry[] {
  const leaves: Entry[] = [];
  for (const node of nodes) {
    if (node.type === "entry") leaves.push(node.entry);
    else leaves.push(...collectLeaves(node.children));
  }
  return leaves;
}
