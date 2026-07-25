import type {
  AgentRunSnapshotDto,
  AgentRunEventInputDto,
  AgentRunStreamEventDto
} from "@aiagent/types";

export interface RunStore {
  create(input: {
    runId: string; requestId: string; userId: string; conversationId: string;
    message: string; clientMessageId: string; mode: "auto" | "report";
    source: "composer" | "report_button"; traceId: string; createdAt: string;
  }): Promise<{ snapshot: AgentRunSnapshotDto; created: boolean }>;
  findById(userId: string, runId: string): Promise<AgentRunSnapshotDto | undefined>;
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
}

export interface RunScheduler {
  schedule(task: () => Promise<void>): void;
}
