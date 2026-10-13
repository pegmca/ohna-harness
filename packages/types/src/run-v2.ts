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

/** run_events.event_type 枚举：loop 事件对齐 pi AgentEvent，retrieval/workflow_node/pdf_export 为能力事件，run_status/run_error 为服务端生命周期补充。 */
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
  | "workflow_node"
  | "pdf_export"
  | "mcp_tool_discovered"
  | "run_status"
  | "run_error"
  | "cost_summary";

/**
 * SSE 与 run_events 共用的 canonical 事件 envelope。
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

/** 创建研究 Run 的请求；显式模式与触发入口分离，避免 UI 泄漏 Agent 路由细节。 */
export interface AgentRunCreateRequestDto {
  message: string;
  conversationId: string;
  /** 服务端模型目录中的稳定 ID；旧客户端缺省时使用目录默认模型。 */
  modelId?: string;
  /** 已上传且属于当前用户的文档 ID；带附件时检索严格限定在该集合。 */
  attachmentDocumentIds?: string[];
  /** 浏览器生成的用户消息幂等键；同一次网络重试必须复用。 */
  clientMessageId?: string;
  /**
   * 客户端提示元数据（阶段 5）：hint="report" 表示用户显式要求研报，
   * 仅用于 system prompt 约束模型调用 generate_report 工具；当前不落库（messages 无 metadata 列）。
   */
  metadata?: { hint?: string };
  mode: "auto" | "report";
  source: "composer" | "report_button";
}

/** 创建异步 Agent run 后立即返回的定位信息。 */
export interface AgentRunAcceptedDto {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  status: RunStatusDtoV2;
  eventsUrl: string;
  snapshotUrl: string;
}
