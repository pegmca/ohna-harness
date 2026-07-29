import type { AgentRunStreamEventDto, TraceEventDto } from "@aiagent/types";

type TraceStreamEvent = Extract<AgentRunStreamEventDto, { type: "trace_event" }>;
export type LiveCategoryStatus = "active" | "completed" | "failed" | "cancelled";

export interface LiveCategoryProjection {
  category: string;
  label: string;
  count: number;
  firstSequence: number;
  latestSequence: number;
  status: LiveCategoryStatus;
  event: TraceStreamEvent;
}

export interface RunActivityProjection {
  category: string;
  label: string;
  count: number;
  status: "completed" | "failed";
}

/**
 * 把 canonical Run events 投影为可 replay 的单活动类别列表。
 *
 * @param events 按到达顺序收到的事件，允许包含 replay 重复项。
 * @returns 按类别首次出现顺序排列的 UI 投影。
 */
export function projectLiveRun(events: AgentRunStreamEventDto[]): LiveCategoryProjection[] {
  const rows = new Map<string, LiveCategoryProjection>();
  let lastSequence = 0;
  let active: string | undefined;
  for (const streamEvent of events) {
    if (streamEvent.sequence <= lastSequence) continue;
    lastSequence = streamEvent.sequence;
    if (streamEvent.type === "trace_event") {
      const [category, label] = categoryOfEvent(streamEvent.event);
      if (active !== category) {
        const previous = active ? rows.get(active) : undefined;
        if (previous) previous.status = "completed";
        active = category;
      }
      const current = rows.get(category);
      rows.set(category, {
        category,
        label,
        count: (current?.count ?? 0) + 1,
        firstSequence: current?.firstSequence ?? streamEvent.sequence,
        latestSequence: streamEvent.sequence,
        status: "active",
        event: streamEvent
      });
      continue;
    }
    if (streamEvent.type === "run_result" || streamEvent.type === "run_error") {
      const current = active ? rows.get(active) : undefined;
      if (current) {
        current.status = streamEvent.type === "run_result"
          ? "completed"
          : streamEvent.error.code === "request_cancelled" ? "cancelled" : "failed";
      }
      active = undefined;
    }
  }
  return [...rows.values()];
}

/**
 * 把终态 Trace 压缩成用户可理解的活动类别，隐藏 provider、span 和原始事件结构。
 *
 * @param events Run 的终态 Trace 事件。
 * @returns 按首次出现顺序排列的回答活动。
 */
export function projectRunActivity(events: TraceEventDto[]): RunActivityProjection[] {
  const rows = new Map<string, RunActivityProjection>();
  for (const event of events) {
    const [category, label] = categoryOfEvent(event);
    const current = rows.get(category);
    rows.set(category, {
      category,
      label,
      count: (current?.count ?? 0) + 1,
      status: current?.status === "failed" || eventFailed(event) ? "failed" : "completed"
    });
  }
  return [...rows.values()];
}

/**
 * 将 Trace 事件映射到用户活动类别；Agent step 依据 stepType 归入实际阶段。
 *
 * @param event Trace 事件的最小分类字段。
 * @returns 固定类别和中文标签。
 */
function categoryOfEvent(event: { type: string; stepType?: string }): [string, string] {
  const { type } = event;
  if (type === "agent_step") {
    const stepType = event.stepType ?? "";
    if (stepType.includes("route")) return ["routing", "理解问题"];
    if (stepType.includes("tool")) return ["tools", "查询数据"];
    if (stepType.includes("model") || stepType.includes("answer")) return ["model", "生成回答"];
    if (stepType.includes("report") || stepType.includes("workflow")) return ["workflow", "执行研究流程"];
  }
  if (type === "request_received" || type === "intent_routed" || type === "security") return ["routing", "理解问题"];
  if (type === "model_call") return ["model", "生成回答"];
  if (type === "retrieval") return ["retrieval", "检索资料"];
  if (type === "tool_call" || type === "mcp_tool_call" || type === "mcp_tool_discovered") return ["tools", "查询数据"];
  if (
    type === "approval"
    || type === "report_skill_activation"
    || type === "report_plan"
    || type === "workflow_node"
    || type === "citation_verifier"
    || type === "pdf_export"
  ) return ["workflow", "执行研究流程"];
  return ["finalizing", "整理结果"];
}

/**
 * 判断终态事件是否表达失败，供活动类别聚合状态使用。
 *
 * @param event Trace 事件。
 * @returns 事件明确失败时为 true。
 */
function eventFailed(event: TraceEventDto): boolean {
  if ("ok" in event && event.ok === false) return true;
  if ("status" in event && event.status === "failed") return true;
  return false;
}
