/**
 * 统一 JSON 阅读器（BUG-003）：节点级展开 / 收起 + 语法高亮 + 长字符串截断。
 *
 * 设计取舍：
 * - **零依赖手写递归树**：引入 JSON 树库要额外承担 bundle 体积与视觉改造（DESIGN.md 一致性），
 *   而需求只是折叠 + 高亮，递归渲染足够；
 * - **惰性渲染取代「超阈值整段不渲染」**：默认只展开根与第一层容器，深层节点折叠时不渲染子树，
 *   初始 DOM 规模由可视深度决定、与记录总大小解耦；只有节点总数超过极高的安全上限
 *   （`MAX_RENDER_NODES`）才退回「只展示根摘要」并提示用复制；
 * - **折叠态零序列化**：树由 `buildJsonTree` 直接从原值构建，不经过 stringify；
 *   调用方需要整段字符串（复制 / 体量展示）时才自己序列化，与 LlmCallBlock 的 S1 一致；
 * - **展开状态全部收敛到本组件**（容器展开 + 长字符串全文），行组件保持无状态：
 *   否则父节点折叠时子树被卸载，行内局部状态（「展开全文」）会丢失，用户再展开又变回截断态。
 */
import { type ReactElement, useCallback, useMemo, useState } from "react";
import type { JsonNode } from "./json-tree.js";
import { JsonRow } from "./json-row.js";
import {
  buildJsonTree,
  childKey,
  collectExpandableKeys,
  DEFAULT_DEPTH,
  ROOT_KEY,
  isOverBudget,
  MAX_BULK_EXPAND_NODES,
  MAX_RENDER_NODES,
  summarizeNode
} from "./json-tree.js";

/** 组件属性。 */
export interface JsonViewerProps {
  /** 任意值；非 JSON 值（undefined / BigInt / 函数 / Symbol）会降级为文本。 */
  value: unknown;
  /** 默认可见层数：默认 2 → 根与第一层容器展开，第二层起折叠。 */
  defaultDepth?: number;
  /** 追加到容器的 class（调用方用于宽度 / 限高微调）。 */
  className?: string;
}

/**
 * 渲染任意值的可折叠 JSON 树。
 *
 * @param props.value 任意值。
 * @param props.defaultDepth 默认可见层数（默认 2）。
 * @param props.className 追加类名。
 * @returns JSON 树容器。
 */
export function JsonViewer(props: JsonViewerProps) {
  const defaultDepth = props.defaultDepth ?? DEFAULT_DEPTH;
  const tree = useMemo(() => buildJsonTree(props.value), [props.value]);
  // 用户操作过的节点显式记录：没记录的节点用 defaultDepth 推导，切换折叠不会因为重建树而丢失状态。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // 长字符串「展开全文」也收敛到这里：键与容器展开键同构，随树重建一起重建，不会跨值串台。
  const [expandedStrings, setExpandedStrings] = useState<Record<string, boolean>>({});
  // 上次「全部展开」因批量预算被跳过的容器数（0 表示全部展开没有截断）。落到 UI 上让截断可见。
  const [skippedOnExpand, setSkippedOnExpand] = useState(0);
  const overBudget = isOverBudget(tree);

  /**
   * 切换单个节点的展开状态。状态更新函数必须保持引用稳定，
   * 否则每次渲染都会让整棵已渲染子树重新渲染（大 JSON 展开后可感知）。
   *
   * @param key 节点键。
   * @param next 目标状态。
   */
  const toggle = useCallback((key: string, next: boolean): void => {
    setOverrides((current) => ({ ...current, [key]: next }));
  }, []);

  /**
   * 把某个长字符串标记为「展开全文」。
   *
   * @param key 节点键。
   */
  const expandString = useCallback((key: string): void => {
    setExpandedStrings((current) => ({ ...current, [key]: true }));
  }, []);

  /**
   * 一键展开 / 一键折叠全部节点。
   *
   * 展开路径的预算取舍：一次性把几万节点铺进 DOM 会卡住主线程，所以只对预算内的键写 `true`，
   * **预算外的键保持原状**（不写 `false`）。早期实现先给所有键写 `false` 再展开前 N 个，
   * 结果在节点数超过预算的树上，点「全部展开」反而把 defaultDepth 已展开、
   * 但排在预算之后的节点强制收了起来——按钮在深树上甚至看起来毫无反应（回归测试已覆盖）。
   *
   * 折叠路径必须覆盖全部键：不写记录的话它们会按 defaultDepth 重新判定，折叠不生效。
   *
   * @param expand 展开为 true。
   */
  const setAll = useCallback(
    (expand: boolean): void => {
      const allKeys = collectExpandableKeys(tree.root);
      if (!expand) {
        setOverrides(Object.fromEntries(allKeys.map((key) => [key, false])) as Record<string, boolean>);
        return;
      }
      const limit = Math.floor(MAX_BULK_EXPAND_NODES / 2);
      const budgeted = allKeys.slice(0, limit);
      setSkippedOnExpand(allKeys.length - budgeted.length);
      // 只合并预算内的键：用函数式更新保留预算外的既有状态（defaultDepth 展开与用户手动展开）。
      setOverrides((current) => {
        const next = { ...current };
        for (const key of budgeted) next[key] = true;
        return next;
      });
    },
    [tree.root]
  );

  if (overBudget) {
    return (
      <div className={`json-viewer ${props.className ?? ""}`.trim()}>
        <p className="json-viewer-budget" role="status">
          节点数超过安全上限（{tree.nodeCount.toLocaleString("zh-CN")} &gt;{" "}
          {MAX_RENDER_NODES.toLocaleString("zh-CN")}），已只展示根摘要；完整内容请用「复制 JSON」。
        </p>
        {tree.root.nodeType === "container" ? (
          <p className="json-viewer-budget-summary">
            <span className="json-viewer-bracket">{tree.root.kind === "object" ? "{" : "["}</span>
            <span className="json-viewer-count">{summarizeNode({ ...tree.root, deep: false })}</span>
            <span className="json-viewer-bracket">{tree.root.kind === "object" ? "}" : "]"}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`json-viewer ${props.className ?? ""}`.trim()}>
      <div className="json-viewer-toolbar">
        <button className="json-viewer-action" onClick={() => setAll(true)} type="button">
          全部展开
        </button>
        <button className="json-viewer-action" onClick={() => setAll(false)} type="button">
          全部折叠
        </button>
        {skippedOnExpand > 0 ? (
          // 预算截断不能静默：告知已展开到上限，剩余节点仍可逐个展开。
          <span className="json-viewer-budget-note" role="status">
            已展开前 {Math.floor(MAX_BULK_EXPAND_NODES / 2).toLocaleString("zh-CN")} 个节点，另有{" "}
            {skippedOnExpand.toLocaleString("zh-CN")} 个嵌套节点保持原状，可逐级展开
          </span>
        ) : null}
      </div>
      {/*
       * 纯 div，不加 role="tree"：行用 disclosure 模式（带 aria-expanded 的按钮），没有 treeitem，
       * 声明 tree 会让读屏播报一棵空树。分组语义由 .json-viewer 的 aria-label 提供。
       */}
      <div className="json-viewer-tree" aria-label="JSON 结构" role="group">
        {renderNode({
          node: tree.root,
          depth: 0,
          key: ROOT_KEY,
          context: { overrides, expandedStrings, defaultDepth, toggle, expandString }
        })}
      </div>
    </div>
  );
}

/** 递归渲染所需的只读上下文（避免长参数列表，也便于以后加「高亮命中」等能力）。 */
interface RenderContext {
  /** 用户操作过的展开状态。 */
  overrides: Record<string, boolean>;
  /** 已标记「展开全文」的长字符串键。 */
  expandedStrings: Record<string, boolean>;
  /** 默认可见层数。 */
  defaultDepth: number;
  /** 切换容器展开。 */
  toggle: (key: string, next: boolean) => void;
  /** 展开长字符串全文。 */
  expandString: (key: string) => void;
}

/** 单个节点的渲染输入。 */
interface RenderNodeOptions {
  /** 节点。 */
  node: JsonNode;
  /** 深度（根为 0）。 */
  depth: number;
  /** 节点展开键（由 `childKey` 编码，避免 `/` 冲突）。 */
  key: string;
  /** 对象键名。 */
  entryKey?: string;
  /** 数组下标。 */
  index?: number;
  /** 渲染上下文。 */
  context: RenderContext;
}

/**
 * 判断节点是否展开（显式 override 优先，否则按默认可见层数推导）。
 *
 * @param overrides 用户操作记录。
 * @param key 节点键。
 * @param depth 深度。
 * @param defaultDepth 默认展开层数。
 * @returns 展开为 true。
 */
function isOpen(overrides: Record<string, boolean>, key: string, depth: number, defaultDepth: number): boolean {
  // 根容器（depth 0）始终展开：否则默认只看到一行 `{n 项}`，阅读器失去意义。
  if (depth === 0) return overrides[key] ?? true;
  return overrides[key] ?? depth < defaultDepth;
}

/**
 * 递归渲染节点及其（仅展开时）子节点。折叠节点不构建子树，这是「大 JSON 惰性渲染」的关键：
 * 初始 DOM 只由可视深度决定，与记录总节点数无关。
 *
 * @param options 节点与渲染上下文（见 `RenderNodeOptions`）。
 * @returns 行片段数组。
 */
function renderNode(options: RenderNodeOptions): ReactElement[] {
  const { node, depth, key, entryKey, index, context } = options;
  const open = node.nodeType === "container" && isOpen(context.overrides, key, depth, context.defaultDepth);
  const rows: ReactElement[] = [
    <JsonRow
      depth={depth}
      entryKey={entryKey}
      expanded={open}
      expandedString={context.expandedStrings[key] === true}
      index={index}
      key={key}
      node={node}
      onExpandString={() => context.expandString(key)}
      onToggle={() => context.toggle(key, !open)}
    />
  ];
  if (open && node.nodeType === "container") {
    node.entries.forEach((entry, childIndex) => {
      const isArrayEntry = entry.key === undefined;
      rows.push(
        ...renderNode({
          node: entry.value,
          depth: depth + 1,
          key: childKey(key, isArrayEntry ? childIndex : (entry.key as string)),
          entryKey: entry.key,
          index: isArrayEntry ? childIndex : undefined,
          context
        })
      );
    });
  }
  return rows;
}
