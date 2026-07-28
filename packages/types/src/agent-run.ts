import type { ApiError } from "./api.js";
import type { ISODateTimeString } from "./primitives.js";
import type { CitationDto } from "./rag.js";
import type { ReportPlanDto, ReportTriggerSourceDto, ReportWorkflowResponseDto } from "./report.js";
import type { AgentIntentDto, AgentStepDto, TraceDto, TraceEventDto } from "./trace.js";

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
  mode: "auto" | "report";
  source: "composer" | "report_button";
}

/** Agent runtime 内部兼容请求；浏览器创建新 Run 时使用 AgentRunCreateRequestDto。 */
export interface AgentRunRequestDto {
  message: string;
  reportMode?: boolean;
  reportTriggerSource?: ReportTriggerSourceDto;
  conversationId?: string;
}

/** 绑定到 URL 中 run 与 approval 资源的最小人工审批输入。 */
export interface RunApprovalDecisionRequestDto {
  decision: "approved" | "rejected";
  reviewerNote?: string;
  inputDigest: string;
}

export interface AgentRunResponseDto {
  runId: string;
  conversationId: string;
  modelId: string;
  requestId: string;
  traceId: string;
  ok: boolean;
  intent: AgentIntentDto;
  answer: string;
  /** grounded answer 的证据引用；持久化为 message citations 后可在来源归档时仍保持序号稳定。 */
  citations?: CitationDto[];
  steps: AgentStepDto[];
  trace: TraceDto;
  /** Trace 旁路持久化状态；降级时只暴露稳定诊断，不包含数据库原始异常。 */
  tracePersistence: {
    status: "complete" | "degraded";
    diagnostic?: {
      code: "trace_persistence_degraded";
      message: string;
    };
  };
  reportPlan?: ReportPlanDto;
  reportWorkflow?: ReportWorkflowResponseDto;
  error?: ApiError;
}

/** 异步研究任务的生命周期状态，供 HTTP snapshot 与 SSE 共同使用。 */
export type AgentRunStatusDto = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

/** 创建异步 Agent run 后立即返回的定位信息。 */
export interface AgentRunAcceptedDto {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  status: AgentRunStatusDto;
  eventsUrl: string;
  snapshotUrl: string;
}

/** SSE 使用的稳定事件 envelope；sequence 同时作为 SSE id 支持断线重放。 */
export type AgentRunStreamEventDto =
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_status";
      status: AgentRunStatusDto;
      message: string;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "trace_event";
      event: TraceEventDto;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_result";
      result: AgentRunResponseDto;
    }
  | {
      eventId: string;
      sequence: number;
      runId: string;
      requestId: string;
      traceId: string;
      conversationId: string;
      createdAt: ISODateTimeString;
      type: "run_error";
      error: ApiError;
    };

/** 持久化 adapter 分配 eventId/sequence 前的 canonical event 输入。 */
export type AgentRunEventInputDto =
  AgentRunStreamEventDto extends infer TEvent
    ? TEvent extends AgentRunStreamEventDto
      ? Omit<TEvent, "eventId" | "sequence">
      : never
    : never;

/** 供刷新和 SSE 断线恢复使用的 run 快照。 */
export interface AgentRunSnapshotDto {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  status: AgentRunStatusDto;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  events: AgentRunStreamEventDto[];
  result?: AgentRunResponseDto;
  error?: ApiError;
}
