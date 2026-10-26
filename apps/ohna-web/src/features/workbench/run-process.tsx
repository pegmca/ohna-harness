import { Activity } from "lucide-react";
import type { UiMessage } from "./types";

/**
 * 已完成 run 的单行状态摘要。
 *
 * 完整运行过程由 Trace 抽屉统一承载；消息内不再提供开发者详情入口，
 * 避免与 Trace 功能重复，也避免展开后出现空内容。
 *
 * @param props 消息。
 * @returns 运行状态摘要。
 */
export function RunDetails(props: { message: UiMessage }) {
  const { message } = props;
  const toolCount = message.blocks.filter((block) => block.type === "toolCall").length;
  const processLabel = [
    message.ok === false || message.status === "failed" ? "运行失败" : "已完成",
    toolCount > 0 ? `调用 ${toolCount} 个工具` : undefined
  ].filter(Boolean).join(" · ");

  return (
    <div className="run-process">
      <span className="run-process-trigger">
        <Activity className="icon-size" />
        <span>{processLabel}</span>
      </span>
    </div>
  );
}
