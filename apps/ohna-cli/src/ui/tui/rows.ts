/**
 * TUI 行投影（Phase C1b）：`TuiEntry[] → string[]` 的**纯函数**。
 *
 * 设计动机（v1.4 计划 D3 / D6）：
 * - 改造前 `tui-app.ts` 维护「已预合成 ANSI 的行数组」；折叠 / 展开只能通过向对话流
 *   追加全文实现。这里改为每次从语义条目重新投影：分组、折叠、上色、截断全部可重算，
 *   因此 ctrl+o 是真正的原地开关，不污染历史。
 * - 归约层（`stream/reducer.ts`）与分类层（`classifier.ts`）不产 ANSI；**上色只发生在
 *   本文件和打印 presenter**。这样同一份 entry 可以同时喂给非 TTY 打印和整屏 TUI。
 * - 每行最后统一 `truncateToWidth(width)`，保证终端永不折行、边框永不错位。
 *
 * verbosity 三档（D6）：
 * - `low`：所有非文本条目合并进 activity 组，折叠成一行摘要；
 * - `medium`：reasoning / exploration 分组且默认折叠，activity 摊平逐条渲染；
 * - `high`：同 medium，但 exploration / reasoning 默认展开。
 *
 * 分组 ID 取「组首叶子 id + kind」。流式追加只会在组尾增加叶子，首叶子不变，
 * 因此同一组的 ID 在整个生命周期内稳定，`expanded` Map 不会因新条目而失效。
 */
import { truncateToWidth } from "@aiagent/term";
import type { TuiEntry, TuiVerbosity } from "../stream/entries.js";
import { CROSS, DOT, ELLIPSIS, HOOK, SPIN, paint, type ThemeRole, type ThemeStyle } from "../theme.js";
import { extractResultText, foldOutput, formatToolArgs, renderToolDiff } from "../stream/print-format.js";
import {
  activitySummary,
  collectLeaves,
  entryPath,
  firstBusyLabel,
  type GroupKind,
} from "./classifier.js";
import { firstLeaf, groupEntries, type GroupNode } from "./grouping.js";

/** 长文本折叠阈值：超过后保留头 15 行 + 尾 10 行，避免一条消息刷满整屏。 */
const TEXT_FOLD_MAX_LINES = 25;
const TEXT_FOLD_HEAD_LINES = 15;
const TEXT_FOLD_TAIL_LINES = 10;

/** {@link projectRows} 的投影选项。 */
export interface ProjectRowsOptions {
  /** verbosity 三档（决定分组与默认展开）。 */
  verbosity: TuiVerbosity;
  /** 用户显式切换过的组展开状态（key 为 {@link groupID}）。 */
  expanded: ReadonlyMap<string, boolean>;
  /** 终端列数；每行最终都按此宽度截断。 */
  width: number;
}

/**
 * 计算分组节点的稳定 ID：组首叶子 id + 组 kind。
 *
 * 取「首叶子」而不是「首子节点」是因为嵌套组的首子节点可能也是组；深度优先找到的
 * 第一条 entry 才是随追加不变的最小锚点。
 *
 * @param node 组节点。
 * @returns 形如 `tool-3:exploration` 的稳定 ID；空组退化为 kind。
 */
export function groupID(node: Extract<GroupNode<TuiEntry, GroupKind>, { type: "group" }>): string {
  const first = firstLeaf(node.children);
  return `${first?.id ?? "empty"}:${node.kind}`;
}

/**
 * 判断某个 kind 在当前 verbosity 下是否**作为组**渲染。
 *
 * activity 在 medium / high 下不显示组头，而是把子项摊平成逐条行——这就是
 * 「activity 逐条」的实现方式，同时保留分类规则里的 activity 路径不变。
 *
 * @param kind 分组维度。
 * @param verbosity 当前档位。
 * @returns true 表示渲染折叠组头；false 表示摊平子项。
 */
export function isGroupedKind(kind: GroupKind, verbosity: TuiVerbosity): boolean {
  if (verbosity === "low") return true;
  return kind !== "activity";
}

/**
 * 判断分组当前是否展开（用户覆盖优先于 verbosity 默认值）。
 *
 * @param node 组节点。
 * @param verbosity 当前档位。
 * @param expanded 用户展开状态表。
 * @returns 展开时为 true。
 */
export function isGroupExpanded(
  node: Extract<GroupNode<TuiEntry, GroupKind>, { type: "group" }>,
  verbosity: TuiVerbosity,
  expanded: ReadonlyMap<string, boolean>,
): boolean {
  const override = expanded.get(groupID(node));
  if (override !== undefined) return override;
  return verbosity === "high" && (node.kind === "exploration" || node.kind === "reasoning");
}

/**
 * 当前投影中「最后一个可折叠组」的描述（ctrl+o 原地开关的目标）。
 *
 * 只把当前 verbosity 下真正渲染组头的节点计入：medium / high 的 activity 是摊平的，
 * 不应成为 ctrl+o 目标。深度优先顺序中最后一个组即屏幕最靠下的组。
 */
export interface LastGroup {
  /** 组稳定 ID。 */
  id: string;
  /** 该组当前的展开状态（含 verbosity 默认值）。 */
  expanded: boolean;
}

/**
 * 求当前投影中最后一个可折叠组及其展开状态。
 *
 * @param entries 条目序列。
 * @param verbosity 当前档位。
 * @param expanded 用户展开状态表。
 * @returns 最后一个组；没有可折叠组时返回 undefined。
 */
export function lastGroup(
  entries: readonly TuiEntry[],
  verbosity: TuiVerbosity,
  expanded: ReadonlyMap<string, boolean>,
): LastGroup | undefined {
  const nodes = groupEntries(entries, (entry) => entryPath(entry, verbosity));
  let last: LastGroup | undefined;
  const visit = (list: readonly GroupNode<TuiEntry, GroupKind>[]): void => {
    for (const node of list) {
      if (node.type !== "group") continue;
      if (isGroupedKind(node.kind, verbosity)) {
        last = { id: groupID(node), expanded: isGroupExpanded(node, verbosity, expanded) };
      }
      visit(node.children);
    }
  };
  visit(nodes);
  return last;
}

/**
 * 求当前投影中「最后一个可折叠组」的 ID（{@link lastGroup} 的便捷包装）。
 *
 * @param entries 条目序列。
 * @param verbosity 当前档位。
 * @returns 组 ID；没有可折叠组时返回 undefined。
 */
export function lastGroupID(entries: readonly TuiEntry[], verbosity: TuiVerbosity): string | undefined {
  return lastGroup(entries, verbosity, new Map())?.id;
}

/**
 * 把语义条目投影成终端行。
 *
 * 纯函数：不修改 entry、不持有缓存、不读终端状态；同样的输入永远得到同样的输出
 * （`renderToolDiff` 会读取工作区当前文件，这是打印路径既有的展示行为）。
 *
 * @param entries 语义条目序列（时间顺序）。
 * @param options verbosity / 展开状态 / 终端宽度。
 * @returns 每行已上色、已按宽度截断的最终文本。
 */
export function projectRows(entries: readonly TuiEntry[], options: ProjectRowsOptions): string[] {
  const nodes = groupEntries(entries, (entry) => entryPath(entry, options.verbosity));
  return projectNodeRows(nodes, options);
}

/**
 * 把**已构建好的分组树**投影成终端行（C4 挂载预算的切片入口）。
 *
 * 与 {@link projectRows} 的区别只是跳过 `groupEntries`：挂载预算在**顶层节点边界**
 * 切片，因此每个折叠组都完整保留，组 ID 与摘要不会因切片而改变。
 *
 * @param nodes 分组树根节点序列（通常已是某个连续切片）。
 * @param options verbosity / 展开状态 / 终端宽度。
 * @returns 每行已上色、已按宽度截断的最终文本。
 */
export function projectNodeRows(
  nodes: readonly GroupNode<TuiEntry, GroupKind>[],
  options: ProjectRowsOptions,
): string[] {
  const lines: string[] = [];
  const width = Math.max(1, options.width);

  const renderNodes = (list: readonly GroupNode<TuiEntry, GroupKind>[], depth: number): void => {
    const indent = "  ".repeat(depth);
    for (const node of list) {
      if (node.type === "entry") {
        lines.push(...renderEntry(node.entry, indent));
        continue;
      }
      if (!isGroupedKind(node.kind, options.verbosity)) {
        // medium / high 的 activity：不显示组头，直接摊平子项（逐条行）。
        renderNodes(node.children, depth);
        continue;
      }
      const expanded = isGroupExpanded(node, options.verbosity, options.expanded);
      lines.push(`${indent}${renderGroupHeader(node, expanded)}`);
      if (expanded) renderNodes(node.children, depth + 1);
    }
  };

  renderNodes(nodes, 0);
  return lines.map((line) => truncateToWidth(line, width));
}

/**
 * 单个分组节点的**挂载权重**（Phase C4，概念移植 opencode `mount-budget.ts`）。
 *
 * 权重单位是「条目行」而非真实终端行：折叠组恒 1（只渲染组头，不展开子项）、
 * 展开组为 `1 + Σ子权重`（组头 + 子项）、叶子为 1。medium / high 下被摊平的 activity
 * 没有组头，权重就是子项之和（与 opencode 的 `grouped=false → node.size` 对齐）。
 *
 * 为什么是「概念」而不是实际测量：ohna 的一条 entry 可能渲染多行（长正文 / 工具输出），
 * 而全帧模型每帧都会同步投影，真实行数由投影结果决定。权重只用于**选择挂载起点**，
 * 可见区仍按真实行从尾部切片（见 `mount.ts`），因此不会出现 opencode 的 afterLayout
 * 补偿滚动问题。
 *
 * @param node 顶层分组节点（叶子或组）。
 * @param verbosity 当前档位（决定 activity 是否摊平）。
 * @param expanded 用户展开状态表。
 * @returns 该节点的挂载权重（非负整数）。
 */
export function rowWeight(
  node: GroupNode<TuiEntry, GroupKind>,
  verbosity: TuiVerbosity,
  expanded: ReadonlyMap<string, boolean>,
): number {
  if (node.type === "entry") return 1;
  const childrenWeight = node.children.reduce(
    (total, child) => total + rowWeight(child, verbosity, expanded),
    0,
  );
  // 摊平渲染没有组头：权重等于子项之和。
  if (!isGroupedKind(node.kind, verbosity)) return childrenWeight;
  // 折叠组只占 1 行；展开组 = 组头 + 子项。
  return isGroupExpanded(node, verbosity, expanded) ? 1 + childrenWeight : 1;
}

/**
 * 渲染折叠组头（1 行）。
 *
 * @param node 组节点。
 * @param expanded 是否展开（决定 `+` / `−` 标记）。
 * @returns 未按宽度截断的组头文本（已上色）。
 */
function renderGroupHeader(
  node: Extract<GroupNode<TuiEntry, GroupKind>, { type: "group" }>,
  expanded: boolean,
): string {
  const leaves = collectLeaves(node.children);
  const summary = activitySummary(leaves);
  const marker = expanded ? "−" : summary.active ? SPIN : "+";

  if (node.kind === "reasoning") {
    const label = summary.active
      ? "思考中…"
      : summary.label || `${leaves.length} thought${leaves.length === 1 ? "" : "s"}`;
    return paint(`${marker} ${label}`, "dim");
  }

  const label = summary.label || firstBusyLabel(leaves) || node.kind;
  return paint(`${marker} ${label}`, summary.active ? "note" : "dim");
}

/**
 * 渲染一条叶子条目（可能是多行）。
 *
 * @param entry 语义条目。
 * @param indent 当前缩进（组展开时每层 2 列）。
 * @returns 已上色、尚未按宽度截断的行。
 */
function renderEntry(entry: TuiEntry, indent: string): string[] {
  switch (entry.kind) {
    case "user":
      return renderPrefixedText(entry.text, indent, "❯ ", "user", "user");
    case "assistant":
      return renderAssistant(entry, indent);
    case "reasoning":
      return renderReasoning(entry, indent);
    case "tool":
      return renderTool(entry, indent);
    case "error":
      return renderError(entry, indent);
    case "notice":
      return renderNotice(entry, indent);
  }
}

/**
 * 渲染 assistant 正文：首行 `⏺`，续行缩进；空流式消息显示「思考中…」占位。
 *
 * @param entry assistant 条目。
 * @param indent 当前缩进。
 * @returns 渲染行。
 */
function renderAssistant(entry: TuiEntry, indent: string): string[] {
  if (!entry.text.trim()) {
    if (entry.status === "streaming") return [`${indent}${paint(`${SPIN} 思考中…`, "dim")}`];
    return [];
  }
  const lines = renderPrefixedText(entry.text, indent, `${DOT} `, "foreground", "foreground");
  if (entry.status === "error") {
    lines.push(
      `${indent}${paint(`${CROSS} 模型调用失败：${entry.meta?.errorMessage || "provider 返回未知错误"}`, "error")}`,
    );
  }
  return lines;
}

/**
 * 渲染 reasoning：首行 `✻`，续行缩进；灰色斜体。
 *
 * @param entry reasoning 条目。
 * @param indent 当前缩进。
 * @returns 渲染行。
 */
function renderReasoning(entry: TuiEntry, indent: string): string[] {
  if (!entry.text.trim()) {
    if (entry.status === "streaming") return [`${indent}${paint(`${SPIN} 思考中…`, "dim")}`];
    return [];
  }
  return renderPrefixedText(entry.text, indent, `${SPIN} `, "dim", "dim", "italic");
}

/**
 * 渲染 notice：`meta.rawAnsi` 为 true 时原样透传（欢迎头 / slash 命令自带上色），
 * 否则按 dim 系统提示渲染。
 *
 * @param entry notice 条目。
 * @param indent 当前缩进。
 * @returns 渲染行。
 */
function renderNotice(entry: TuiEntry, indent: string): string[] {
  const raw = entry.text.split("\n");
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  if (entry.meta?.rawAnsi) return raw.map((line) => `${indent}${line}`);
  return raw.map((line) => `${indent}${paint(line, "dim")}`);
}

/**
 * 渲染运行级 error（agent_end.error）。
 *
 * @param entry error 条目。
 * @param indent 当前缩进。
 * @returns 渲染行。
 */
function renderError(entry: TuiEntry, indent: string): string[] {
  const message = entry.meta?.errorMessage ?? entry.text;
  return message
    .split("\n")
    .map((line) => `${indent}${paint(`${CROSS} 运行异常终止（${entry.meta?.code ?? "unknown"}）：${line}`, "error")}`);
}

/**
 * 渲染工具调用：`⏺ tool(args)` + 可选写前 diff + `⎿ 结果`。
 *
 * 参数摘要 / diff / 结果折叠全部复用打印 presenter 的纯函数；完整原文始终留在
 * `entry.meta.result` 上，这里不建立任何「折叠全文缓存」。
 *
 * @param entry tool 条目。
 * @param indent 当前缩进。
 * @returns 渲染行。
 */
function renderTool(entry: TuiEntry, indent: string): string[] {
  const name = entry.meta?.toolName ?? "";
  const args = formatToolArgs(name, entry.meta?.args);
  const lines = [`${indent}${paint(DOT, "accent")} ${paint(name, "accent", "bold")}(${paint(args, "dim")})`];

  const diff = renderToolDiff(name, entry.meta?.args);
  if (diff) {
    const diffLines = diff.split("\n");
    diffLines.forEach((line, index) => {
      const role = index === 0 ? "property" : line.startsWith("+") ? "success" : line.startsWith("-") ? "error" : "dim";
      lines.push(`${indent}  ${paint(line, role)}`);
    });
  }

  if (entry.status === "running") return lines;
  const result = extractResultText(entry.meta?.result);
  if (entry.status === "error") {
    lines.push(`${indent}  ${paint(`${HOOK} ${CROSS}`, "error")} ${paint(result.slice(0, 400), "error")}`);
    return lines;
  }
  if (!result) {
    lines.push(`${indent}  ${paint(HOOK, "dim")} `);
    return lines;
  }
  const folded = foldOutput(result, "（ctrl+o 展开分组 · 完整输出见 /export）").split("\n");
  folded.forEach((line, index) => {
    const prefix = index === 0 ? `${HOOK} ` : "  ";
    lines.push(`${indent}  ${paint(prefix, "dim")}${line}`);
  });
  return lines;
}

/**
 * 多行文本的统一前缀渲染：首行带标记，续行对齐缩进；超长时头尾折叠。
 *
 * @param text 未上色原文（可含 `\n`）。
 * @param indent 当前缩进。
 * @param marker 首行标记（如 `⏺ ` / `❯ `）。
 * @param role 正文颜色角色。
 * @param markerRole 标记颜色角色。
 * @returns 渲染行。
 */
function renderPrefixedText(
  text: string,
  indent: string,
  marker: string,
  role: ThemeRole,
  markerRole: ThemeRole,
  style?: ThemeStyle,
): string[] {
  const raw = text.split("\n");
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const folded = foldTextLines(raw);
  return folded.map((line, index) => {
    if (index === 0) return `${indent}${paint(marker, markerRole)}${paint(line, role, style)}`;
    if (line.startsWith(`${ELLIPSIS} +`)) return `${indent}${paint(line, "dim")}`;
    return `${indent}  ${paint(line, role, style)}`;
  });
}

/**
 * 长文本头尾折叠（head 15 + tail 10），与打印 presenter 的工具输出折叠策略一致。
 *
 * @param lines 原始行。
 * @returns 折叠后的行（未超阈值时原样返回同一数组的副本）。
 */
function foldTextLines(lines: readonly string[]): string[] {
  if (lines.length <= TEXT_FOLD_MAX_LINES) return [...lines];
  const head = lines.slice(0, TEXT_FOLD_HEAD_LINES);
  const tail = lines.slice(-TEXT_FOLD_TAIL_LINES);
  const omitted = lines.length - head.length - tail.length;
  return [...head, `${ELLIPSIS} +${omitted} 行`, ...tail];
}
