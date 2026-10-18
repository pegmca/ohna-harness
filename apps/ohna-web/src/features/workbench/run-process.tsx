import { Activity, ChevronDown } from "lucide-react";
import type { RunDetailSection, UiMessage } from "./types";

/**
 * 已完成 run 的折叠单行摘要；过程内容已从 assistant 消息块派生，不再依赖 trace DTO。
 *
 * @param props 消息与详情入口。
 * @returns 默认折叠的运行过程。
 */
export function RunDetails(props: {
  message: UiMessage;
  onOpen: (section: RunDetailSection) => void;
}) {
  const { message } = props;
  const toolCount = message.blocks.filter((block) => block.type === "toolCall").length;
  const processLabel = [
    message.ok === false || message.status === "failed" ? "运行失败" : "已完成",
    toolCount > 0 ? `调用 ${toolCount} 个工具` : undefined
  ].filter(Boolean).join(" · ");

  return (
    <div className="run-process">
      <details>
        <summary className="run-process-trigger">
          <Activity className="icon-size" />
          <span>{processLabel}</span>
          <ChevronDown className="details-chevron" />
        </summary>
        <div className="run-process-body">
          <button className="developer-detail-trigger" onClick={() => props.onOpen("summary")} type="button">
            查看开发者详情
          </button>
        </div>
      </details>
    </div>
  );
}
