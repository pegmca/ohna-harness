/**
 * 单行节点渲染（纯展示）：键 / 值 / 折叠摘要 / 展开按钮 / 长字符串「展开全文」。
 *
 * 拆成独立文件是因为 `JsonViewer` 只负责展开状态编排，行组件没有任何状态，
 * 便于单独测试与复用（例如以后的搜索结果高亮）。
 *
 * 「展开全文」的状态刻意**不放在行组件里**：父节点折叠时子树会被卸载，
 * 行内 state 随之丢失，用户重新展开后长字符串又变回截断态（可感知的状态丢失）。
 * 因此由 `JsonViewer` 以节点键为索引统一持有，行只接收 `expandedString` 与回调。
 */
import { ChevronDown } from "lucide-react";
import type { JsonNode } from "./json-tree.js";
import { formatStringPreview, MAX_STRING_LENGTH, summarizeNode, truncateString } from "./json-tree.js";

/** 行组件属性。 */
export interface JsonRowProps {
  /** 节点键名；数组元素为 undefined。 */
  entryKey?: string;
  /** 数组元素下标；对象条目为 undefined。 */
  index?: number;
  /** 节点本身。 */
  node: JsonNode;
  /** 节点深度（根为 0），用于缩进与默认折叠。 */
  depth: number;
  /** 容器是否展开；叶子节点忽略。 */
  expanded: boolean;
  /** 长字符串是否已「展开全文」（由父组件持有，跨折叠保持）。 */
  expandedString: boolean;
  /** 切换容器展开状态。 */
  onToggle: () => void;
  /** 请求展开长字符串全文。 */
  onExpandString: () => void;
}

/**
 * 渲染一行 JSON 节点；容器展开时由父组件递归渲染子行。
 *
 * @param props 行属性。
 * @returns 行元素。
 */
export function JsonRow(props: JsonRowProps) {
  const { node } = props;
  const key = props.entryKey;
  return (
    <div
      className="json-viewer-row"
      data-depth={props.depth}
      /*
       * 不用 role="treeitem"：树语义要求 treeitem 嵌套在 group 里，否则屏幕阅读器会把
       * 扁平兄弟行读成同一层级。这里用「可聚焦按钮 + aria-expanded」表达折叠状态，
       * 是 WAI-ARIA disclosure 模式，键盘与读屏都可靠。
       */
      style={{ ["--json-viewer-depth" as string]: String(props.depth) }}
    >
      <span className="json-viewer-indent" aria-hidden="true" />
      {node.nodeType === "container" ? (
        <button
          aria-expanded={props.expanded}
          // 根节点没有键：用显式 aria-label 保持按钮可被读屏与测试按名称定位。
          aria-label={key !== undefined ? `展开/收起 ${key}` : "展开/收起根节点"}
          className="json-viewer-toggle"
          onClick={props.onToggle}
          type="button"
        >
          <ChevronDown className={`icon-size details-chevron ${props.expanded ? "is-open" : ""}`} />
        </button>
      ) : (
        <span className="json-viewer-toggle-spacer" aria-hidden="true" />
      )}
      {key !== undefined ? (
        <span className="json-viewer-key">{key}</span>
      ) : props.index !== undefined ? (
        <span className="json-viewer-index">{props.index}</span>
      ) : null}
      <JsonValue
        expanded={props.expanded}
        expandedString={props.expandedString}
        node={node}
        onExpandString={props.onExpandString}
        onToggle={props.onToggle}
      />
    </div>
  );
}

/** 值区域属性。 */
export interface JsonValueProps {
  /** 节点。 */
  node: JsonNode;
  /** 容器是否展开。 */
  expanded: boolean;
  /** 长字符串是否已展开全文。 */
  expandedString: boolean;
  /** 点击折叠摘要时展开容器。 */
  onToggle: () => void;
  /** 展开长字符串全文。 */
  onExpandString: () => void;
}

/**
 * 渲染节点「值」部分：容器给 `{` / `[` 与折叠摘要，叶子按类别高亮。
 *
 * @param props 值属性。
 * @returns 值元素。
 */
export function JsonValue(props: JsonValueProps) {
  const { node } = props;
  if (node.nodeType === "container") {
    const open = node.kind === "object" ? "{" : "[";
    const close = node.kind === "object" ? "}" : "]";
    // 展开态：容器括号整体渲染一次（子节点缩进由 CSS 按深度表达，不额外套容器）。
    if (props.expanded && !node.deep) {
      return (
        <span className="json-viewer-bracket">
          {open}
          {close}
        </span>
      );
    }
    // 折叠态：摘要本身可点（等于整行按钮的快捷入口），键盘仍走 toggle 按钮。
    return (
      <button className="json-viewer-summary" onClick={props.onToggle} tabIndex={-1} type="button">
        <span className="json-viewer-bracket">{open}</span>
        <span className="json-viewer-count">
          {node.deep ? node.deepText ?? summarizeNode(node) : summarizeNode(node)}
        </span>
        <span className="json-viewer-bracket">{close}</span>
      </button>
    );
  }
  if (node.kind === "string") {
    return (
      <StringValue
        expanded={props.expandedString}
        onExpand={props.onExpandString}
        text={node.text}
      />
    );
  }
  return (
    <span
      className={`json-viewer-${node.kind}`}
      title={node.kind === "unsupported" ? "非 JSON 值，已降级为文本" : undefined}
    >
      {node.text}
    </span>
  );
}

/** 字符串叶子属性。 */
export interface StringValueProps {
  /** 原始字符串（未转义、未截断）。 */
  text: string;
  /** 是否已展开全文。 */
  expanded: boolean;
  /** 请求展开全文。 */
  onExpand: () => void;
}

/**
 * 字符串叶子：默认截断，超长时提供「展开全文」按钮（状态由父组件持有，见文件头注释）。
 *
 * @param props 字符串属性。
 * @returns 字符串元素。
 */
export function StringValue(props: StringValueProps) {
  const truncated = truncateString(props.text, MAX_STRING_LENGTH);
  if (!truncated.truncated || props.expanded) {
    return <span className="json-viewer-string">&quot;{formatStringPreview(props.text, false)}&quot;</span>;
  }
  return (
    <>
      <span className="json-viewer-string">&quot;{formatStringPreview(truncated.text, true)}&quot;</span>
      <button className="json-viewer-more" onClick={props.onExpand} type="button">
        展开全文（{props.text.length} 字符）
      </button>
    </>
  );
}
