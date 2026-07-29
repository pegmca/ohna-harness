import type {
  AgentRunResponseDto,
  AgentRunStreamEventDto,
  ChatAttachmentDto,
  MessageAttachmentDto
} from "@aiagent/types";

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "pending" | "failed" | "cancelled";
export type WorkspaceView = "chat" | "scheduled-tasks" | "data-sources" | "workflow" | "citations" | "eval" | "architecture" | "settings";

export interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  ok?: boolean;
  run?: AgentRunResponseDto;
  streamEvents?: AgentRunStreamEventDto[];
  attachments?: Array<ChatAttachmentDto | MessageAttachmentDto>;
  modelId?: string;
  retryContext?: RetryRunContext;
}

/** 失败消息重试所需的不可变 Run 输入快照，避免读取已变化的 Composer 状态。 */
export interface RetryRunContext {
  message: string;
  modelId: string;
  reportMode: boolean;
  attachments: MessageAttachmentDto[];
}

export type DraftAttachmentStatus = "uploading" | "indexed" | "failed";

export interface DraftAttachment {
  clientAttachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: DraftAttachmentStatus;
  documentId?: string;
  error?: string;
  file: File;
}

export interface SelectedRunDetail {
  run?: AgentRunResponseDto;
  event?: AgentRunStreamEventDto;
  section?: RunDetailSection;
}

export type RunDetailSection = "summary" | "steps" | "tools" | "trace" | "report" | "approvals";

export type TraceEventDto = AgentRunResponseDto["trace"]["events"][number];
