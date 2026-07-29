import type { AgentRunStreamEventDto } from "@aiagent/types";

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
      const [category, label] = categoryOf(streamEvent.event.type);
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

/** @param type Trace event type。 @returns 固定类别和标签。 */
function categoryOf(type: string): [string, string] {
  if (type === "request_received" || type === "intent_routed" || type === "security") return ["routing", "Routing"];
  if (type === "model_call") return ["model", "Model"];
  if (type === "retrieval") return ["retrieval", "Retrieval"];
  if (type === "tool_call" || type === "mcp_tool_call" || type === "mcp_tool_discovered") return ["tools", "Tools"];
  if (
    type === "approval"
    || type === "report_skill_activation"
    || type === "report_plan"
    || type === "workflow_node"
    || type === "citation_verifier"
    || type === "pdf_export"
  ) return ["workflow", "Workflow"];
  return ["finalizing", "Finalizing"];
}
