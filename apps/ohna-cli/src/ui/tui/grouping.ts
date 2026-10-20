/**
 * 语义分组树（Phase C1b）。
 *
 * 参考自 opencode `packages/tui/src/routes/session/grouping/tree.ts` (MIT)。
 * 原实现服务于 opencode 的 session 树；这里去掉 Solid/客户端类型，只保留
 * 「相邻同 kind 合并 + 后代叶子计数 + 对象身份保留」的纯数据结构。
 *
 * 为什么需要它：TUI 的投影层不再维护「已经画好的 ANSI 行」，而是每次从
 * `TuiEntry[]` 重新构建一棵分组树。树的节点大小 `size` 表示**后代叶子数**，
 * 与折叠状态无关——折叠组恒渲染 1 行（C4 挂载预算会直接消费这个字段）。
 *
 * 对象身份约定：`mergeGroups` / `splitGroups` 只重建接缝处的祖先节点，
 * 未触及的子树保持原引用。这样 C4 的增量挂载可以按引用做差分，而不必深比较。
 */

/**
 * 分组树节点：叶子直接包住一条 entry；组节点按 kind 收纳连续相邻的同类路径。
 *
 * @template Entry 叶子条目类型（ohna 中为 `TuiEntry`）。
 * @template Kind 分组维度（ohna 中为 `"reasoning" | "exploration" | "activity"`）。
 */
export type GroupNode<Entry, Kind extends string> =
  | { readonly type: "entry"; readonly entry: Entry; readonly size: 1 }
  | {
      readonly type: "group";
      readonly kind: Kind;
      readonly children: readonly GroupNode<Entry, Kind>[];
      /** 后代叶子数，与展开 / 折叠状态无关。 */
      readonly size: number;
    };

/** 构建期可写节点：对外发布后统一视为只读（避免调用方误改投影树）。 */
type BuildingNode<Entry, Kind extends string> =
  | { type: "entry"; entry: Entry; size: 1 }
  | { type: "group"; kind: Kind; children: BuildingNode<Entry, Kind>[]; size: number };

/**
 * 按每条 entry 的分组路径构建相邻合并的分组树。
 *
 * 路径为空数组的 entry 成为独立叶子；路径相同的**相邻** entry 会逐层合并，
 * 中间插入其他 kind 时自然断开（这正是「相邻同 kind 合并」语义）。
 *
 * @template Entry 叶子条目类型。
 * @template Kind 分组维度。
 * @param entries 有序 entry 序列。
 * @param path 从单条 entry 求分组路径的纯函数。
 * @returns 只读分组树（根节点序列）。
 */
export function groupEntries<Entry, Kind extends string>(
  entries: readonly Entry[],
  path: (entry: Entry) => readonly Kind[],
): readonly GroupNode<Entry, Kind>[] {
  const result: BuildingNode<Entry, Kind>[] = [];
  for (const entry of entries) appendEntry(result, entry, path(entry));
  return result;
}

/**
 * 把一条 entry 追加到当前层级；若最后一个节点是同 kind 组则下沉复用。
 *
 * @template Entry 叶子条目类型。
 * @template Kind 分组维度。
 * @param nodes 当前层级的可写节点序列。
 * @param entry 待追加的叶子。
 * @param path 该叶子的完整分组路径。
 * @param depth 当前递归深度（对应 path 下标）。
 */
function appendEntry<Entry, Kind extends string>(
  nodes: BuildingNode<Entry, Kind>[],
  entry: Entry,
  path: readonly Kind[],
  depth = 0,
): void {
  const kind = path[depth];
  if (kind === undefined) {
    nodes.push({ type: "entry", entry, size: 1 });
    return;
  }
  const previous = nodes.at(-1);
  if (previous?.type === "group" && previous.kind === kind) {
    previous.size += 1;
    appendEntry(previous.children, entry, path, depth + 1);
    return;
  }
  const children: BuildingNode<Entry, Kind>[] = [];
  appendEntry(children, entry, path, depth + 1);
  nodes.push({ type: "group", kind, children, size: 1 });
}

/**
 * 顺序拼接两个互不重叠的树片段，并在接缝处递归合并同 kind 组。
 *
 * 这是「拼接」而非「摄入」：调用方必须先自行去重 / 对齐分页，重叠的 entry
 * 这里不会被静默合并（相等内容也可能是两条独立记录）。
 *
 * @template Entry 叶子条目类型。
 * @template Kind 分组维度。
 * @param left 左侧树片段。
 * @param right 右侧树片段。
 * @returns 拼接后的树；未触及的子树保持原对象身份。
 */
export function mergeGroups<Entry, Kind extends string>(
  left: readonly GroupNode<Entry, Kind>[],
  right: readonly GroupNode<Entry, Kind>[],
): readonly GroupNode<Entry, Kind>[] {
  if (!left.length) return right;
  if (!right.length) return left;
  const a = left[left.length - 1];
  const b = right[0];
  if (a.type !== "group" || b.type !== "group" || a.kind !== b.kind) return [...left, ...right];
  return [
    ...left.slice(0, -1),
    {
      type: "group",
      kind: a.kind,
      size: a.size + b.size,
      children: mergeGroups(a.children, b.children),
    },
    ...right.slice(1),
  ];
}

/**
 * 在深度优先的叶子偏移处切分分组树。
 *
 * 组头本身不计数，只有叶子计入 `count`；缓存的 `size` 让整棵子树可被跳过，
 * 只重建跨切点的祖先。切出的两半可以再次 `mergeGroups` 拼回，语义不变。
 *
 * @template Entry 叶子条目类型。
 * @template Kind 分组维度。
 * @param nodes 待切分的树。
 * @param count 左侧保留的叶子数（非负整数）。
 * @returns 左右两半；越界或非法参数抛出 `RangeError`。
 */
export function splitGroups<Entry, Kind extends string>(
  nodes: readonly GroupNode<Entry, Kind>[],
  count: number,
): readonly [readonly GroupNode<Entry, Kind>[], readonly GroupNode<Entry, Kind>[]] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Group split requires a non-negative integer");
  if (count === 0) return [[], nodes];
  let offset = 0;
  for (const [index, node] of nodes.entries()) {
    const end = offset + node.size;
    if (count === end) return [nodes.slice(0, index + 1), nodes.slice(index + 1)];
    if (count < end) {
      if (node.type !== "group") throw new RangeError("Cannot split inside an entry");
      const size = count - offset;
      const [left, right] = splitGroups(node.children, size);
      return [
        [...nodes.slice(0, index), { ...node, children: left, size }],
        [{ ...node, children: right, size: node.size - size }, ...nodes.slice(index + 1)],
      ];
    }
    offset = end;
  }
  throw new RangeError("Group split exceeds entry count");
}

/**
 * 取子树中的第一个叶子 entry（深度优先顺序）。
 *
 * 组 ID 的稳定锚点依赖「组首叶子」：流式追加只会往组尾加叶子，首叶子不变，
 * 因此 `groupID` 在追加过程中保持稳定（见 `rows.ts`）。
 *
 * @template Entry 叶子条目类型。
 * @template Kind 分组维度。
 * @param nodes 分组树节点序列。
 * @returns 第一个叶子；空树返回 undefined。
 */
export function firstLeaf<Entry, Kind extends string>(
  nodes: readonly GroupNode<Entry, Kind>[],
): Entry | undefined {
  for (const node of nodes) {
    if (node.type === "entry") return node.entry;
    const nested = firstLeaf(node.children);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
