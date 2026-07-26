import type { ISODateTimeString } from "./primitives.js";
import type { ToolApprovalRequestDto } from "./trace.js";

export type WorkflowRunStatusDto = "pending" | "running" | "paused" | "approved" | "rejected" | "succeeded" | "failed";

export type WorkflowNodeStatusDto = "pending" | "running" | "paused" | "approved" | "rejected" | "succeeded" | "failed" | "skipped";

export type WorkflowErrorCodeDto =
  | "invalid_workflow"
  | "invalid_node_input"
  | "invalid_node_output"
  | "node_execution_failed"
  | "node_timeout"
  | "workflow_deadline_exceeded"
  | "workflow_cancelled"
  | "retry_exhausted"
  | "max_steps_exceeded"
  | "approval_required"
  | "approval_rejected";

export interface WorkflowErrorDto {
  code: WorkflowErrorCodeDto;
  message: string;
  nodeId?: string;
  details?: Record<string, unknown>;
}

export interface WorkflowNodeDto {
  nodeId: string;
  type: string;
  title: string;
  status: WorkflowNodeStatusDto;
  startedAt?: ISODateTimeString;
  completedAt?: ISODateTimeString;
  durationMs: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  error?: WorkflowErrorDto;
}

export interface WorkflowEdgeDto {
  from: string;
  to: string;
}

export interface WorkflowEventDto {
  id: string;
  type:
    | "node_started"
    | "node_succeeded"
    | "node_failed"
    | "node_paused"
    | "node_approved"
    | "node_rejected"
    | "workflow_paused"
    | "workflow_approved"
    | "workflow_rejected"
    | "workflow_failed"
    | "workflow_succeeded";
  nodeId?: string;
  createdAt: ISODateTimeString;
  data?: Record<string, unknown>;
  error?: WorkflowErrorDto;
}

export interface WorkflowRunDto {
  runId: string;
  workflowName: string;
  status: WorkflowRunStatusDto;
  startedAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
  durationMs: number;
  maxSteps: number;
  executedSteps: number;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  events: WorkflowEventDto[];
  approvalRequest?: ToolApprovalRequestDto;
  error?: WorkflowErrorDto;
  partial?: boolean;
  recovery?: Array<{ nodeId: string; action: "retried" | "skipped" | "partial"; attempts: number; reason: string }>;
}
