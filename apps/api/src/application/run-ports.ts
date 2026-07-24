import type {
  AgentRunSnapshotDto,
  AgentRunStreamEventDto
} from "@aiagent/types";

export interface RunStore {
  insert(snapshot: AgentRunSnapshotDto): Promise<void>;
  findById(runId: string): Promise<AgentRunSnapshotDto | undefined>;
  save(snapshot: AgentRunSnapshotDto): Promise<void>;
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
