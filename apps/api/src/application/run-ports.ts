import type {
  AgentRunSnapshotDto,
  AgentRunEventInputDto,
  AgentRunStreamEventDto
} from "@aiagent/types";

export interface RunStore {
  create(input: {
    runId: string; requestId: string; userId: string; conversationId: string;
    message: string; clientMessageId: string; mode: "auto" | "report";
    source: "composer" | "report_button"; modelId: string; attachmentDocumentIds: string[];
    traceId: string; createdAt: string;
  }): Promise<{ snapshot: AgentRunSnapshotDto; created: boolean }>;
  findById(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
  listAttachmentDocumentIds(userId: string, runId: string): Promise<string[] | undefined>;
  append(userId: string, runId: string, event: AgentRunEventInputDto): Promise<AgentRunStreamEventDto | undefined>;
  listEvents(userId: string, runId: string, afterSequence: number): Promise<AgentRunStreamEventDto[] | undefined>;
  recoverStale(before: string, occurredAt: string): Promise<AgentRunStreamEventDto[]>;
}

export interface RunEventBus {
  publish(event: AgentRunStreamEventDto): void;
  subscribe(runId: string, listener: (event: AgentRunStreamEventDto) => void): () => void;
}

export interface RunExecutionRegistry {
  create(runId: string): AbortController;
  get(runId: string): AbortController | undefined;
  delete(runId: string): void;
  /** @returns 仍在执行中的 runId 列表，供 graceful shutdown drain 与批量中断使用。 */
  list(): string[];
}

export interface RunScheduler {
  schedule(task: () => Promise<void>): void;
}
