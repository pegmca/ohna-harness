import type {
  AgentRunResponseDto,
  AgentRunStreamEventDto
} from "@aiagent/types";

export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "pending" | "failed";
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
}

export interface SelectedRunDetail {
  run?: AgentRunResponseDto;
  event?: AgentRunStreamEventDto;
  section?: RunDetailSection;
}

export type RunDetailSection = "summary" | "steps" | "tools" | "trace" | "report" | "approvals";

export type TraceEventDto = AgentRunResponseDto["trace"]["events"][number];
