import type { AgentRunResponseDto } from "@aiagent/types";
import { Activity, ChevronDown, FileText, ShieldCheck } from "lucide-react";
import { getApprovalRequests } from "./format";
import { projectRunActivity } from "./live-run-projection";
import type { RunDetailSection } from "./types";

/**
 * 渲染回答正文前的用户可读运行过程，业务动作与开发诊断保持分层。
 *
 * @param props Run 与详情入口。
 * @returns 默认折叠的运行过程。
 */
export function RunDetails(props: {
  onOpen: (section: RunDetailSection) => void;
  run: AgentRunResponseDto;
}) {
  const { run } = props;
  const toolEvents = run.trace.events.filter(
    (event) => event.type === "tool_call" || event.type === "mcp_tool_call"
  );
  const approvalRequests = getApprovalRequests(run);
  const activities = projectRunActivity(run.trace.events);
  const processLabel = [
    run.ok ? "已完成" : "运行失败",
    toolEvents.length > 0 ? `调用 ${toolEvents.length} 个工具` : undefined,
    formatRunDuration(run.trace.summary.durationMs)
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
          <ol className="run-activity-list">
            {activities.map((activity) => (
              <li className={`is-${activity.status}`} key={activity.category}>
                <span aria-hidden="true" />
                <strong>{activity.label}</strong>
              </li>
            ))}
          </ol>
          <button className="developer-detail-trigger" onClick={() => props.onOpen("summary")} type="button">
            查看开发者详情
          </button>
        </div>
      </details>
      <div className="run-business-actions">
        {run.reportPlan || run.reportWorkflow ? (
          <button className="run-process-trigger" onClick={() => props.onOpen("report")} type="button">
            <FileText className="icon-size" /><span>查看报告过程</span>
          </button>
        ) : null}
        {approvalRequests.length > 0 ? (
          <button className="run-process-trigger is-attention" onClick={() => props.onOpen("approvals")} type="button">
            <ShieldCheck className="icon-size" /><span>{approvalRequests.length} 项操作待确认</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 将请求总耗时格式化为适合消息摘要的短文本。
 *
 * @param durationMs 总耗时毫秒数。
 * @returns 毫秒或秒单位文本。
 */
export function formatRunDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)} 毫秒` : `${(durationMs / 1_000).toFixed(1)} 秒`;
}
