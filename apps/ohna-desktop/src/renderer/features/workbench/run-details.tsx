import { Braces } from "lucide-react";
import type { ReactNode } from "react";
import { JsonViewer } from "../json-viewer/index.js";

export { RunDetails } from "./run-process";

/**
 * 以折叠方式展示 JSON，防止长 request payload 撑破对话区。
 * 外层 `<details>` 管整块开合，展开体交给统一的 `JsonViewer`（BUG-003：节点级折叠 + 高亮）。
 *
 * @param props 组件属性。
 * @returns JSON 折叠块。
 */
export function JsonDetails(props: { title: string; value: unknown }) {
  return (
    <details className="json-details">
      <summary>
        <Braces className="icon-size" />
        {props.title}
      </summary>
      <JsonViewer value={props.value} />
    </details>
  );
}

/**
 * 渲染小型状态标签，统一 run、会话和 composer 状态表达。
 *
 * @param props 组件属性。
 * @returns 状态标签。
 */
export function StatusBadge(props: { children: ReactNode; tone: "danger" | "info" | "neutral" | "success" }) {
  return <span className={`status-badge tone-${props.tone}`}>{props.children}</span>;
}
