/**
 * 阶段 3 线性持久化的 Run / 事件协议 DTO（docs/worktree/05）。
 *
 * 与旧 agent-run.ts 的差异：事件类型换成 pi AgentEvent 命名（loop 事件直接作为
 * 顶层事件），run 状态机用 completed 替换 succeeded、删除 waiting_approval、
 * 新增 interrupted；version 乐观锁由 last_event_sequence 高水位替代。
 * 旧 DTO 本阶段保留（前端阶段 4 才切换），新协议全部集中在本文件。
 */

/** 新 Run 状态机：终态为 completed/failed/cancelled/interrupted，不可回退。 */
export type RunStatusDtoV2 =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** run_events_v2.event_type 枚举：loop 事件对齐 pi AgentEvent，run_status/run_error 为服务端生命周期补充。 */
export type RunEventTypeDto =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "retrieval"
  | "run_status"
  | "run_error";

/**
 * SSE 与 run_events_v2 共用的 canonical 事件 envelope。
 * payload：loop 事件为 AgentEvent JSON 本体；run_status 为 {status, message}；
 * run_error 为 {error: ApiError}。
 */
export interface RunStreamEventDtoV2 {
  eventId: string;
  runId: string;
  requestId: string;
  conversationId: string;
  /** run 内从 1 连续递增的持久序号，SSE Last-Event-ID 续传基准。 */
  sequence: number;
  type: RunEventTypeDto;
  payload: unknown;
  createdAt: string;
}

/** appendEvent 的输入：由存储分配 eventId 与 sequence。 */
export type RunEventInputDtoV2 = Omit<RunStreamEventDtoV2, "eventId" | "sequence">;

/** GET /api/runs/:runId 的快照 DTO。 */
export interface RunSnapshotDtoV2 {
  runId: string;
  requestId: string;
  conversationId: string;
  userMessageId: string;
  modelId: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
  status: RunStatusDtoV2;
  /** 已持久化的最大事件序号（崩溃恢复与 SSE 续传高水位）。 */
  lastEventSequence: number;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}
