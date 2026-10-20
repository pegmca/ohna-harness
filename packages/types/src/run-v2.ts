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

/**
 * run 模式：auto/report 是托管执行（服务端跑 agentLoop），
 * observe 是 CLI 镜像观测（执行权在 CLI 本地，serve 只承接事件）。
 */
export type RunModeDtoV2 = "auto" | "report" | "observe";

/** run 触发入口：composer/report_button 来自 Web，cli 来自 CLI 镜像观测。 */
export type RunSourceDtoV2 = "composer" | "report_button" | "cli";

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
  /** 编码 Agent 本地扩展：写/执行前等待用户在 Web 端允许或拒绝（payload 见 confirm-gate）。 */
  | "confirmation_requested"
  | "run_status"
  | "run_error"
  | "cost_summary"
  /**
   * 编码 Agent 本地扩展（ohna 观测台）：一次 LLM 请求/响应的完整记录，
   * payload 为 `LlmCallRecordDto`（见 llm-trace.ts）。可持久化，非瞬态。
   */
  | "llm_call";

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
  mode: RunModeDtoV2;
  source: RunSourceDtoV2;
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
  /**
   * 执行检查点：每轮提交后写入（turn / lastEventSequence / createdAt），
   * 支持从最近检查点续跑而非整 Run 重排。无则为 undefined（尚未产出检查点或内存实现）。
   */
  lastCheckpoint?: {
    /** 已完成轮数（每个 assistant 终态消息为一轮）。 */
    turn: number;
    /** 该轮结束时的事件高水位，续跑从此序号之后重建上下文。 */
    lastEventSequence: number;
    /** 检查点写入时间。 */
    createdAt: string;
  };
}

/**
 * 会话下的 run 摘要（观测台 runs 侧栏）。
 *
 * 与快照的区别：只保留列表需要的定位字段 + 当前状态，不含 error/检查点等详情。
 * 状态由服务端「内存态活跃 run 优先、否则回读 run 事件文件」解析。
 */
export interface RunMetaDtoV2 {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  mode: RunModeDtoV2;
  source: RunSourceDtoV2;
  status: RunStatusDtoV2;
  createdAt: string;
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
