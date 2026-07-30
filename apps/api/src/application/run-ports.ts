import type { RunEventInputDtoV2, RunSnapshotDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";

/**
 * Run 存储端口（docs/worktree/05 RunStore 草案）：线性消息 + append-only 事件。
 * 与 packages/database 的 RunRepository 结构对齐；create 输入由 database 包定义
 * （CreateRunInputV2），此处结构化复用避免循环依赖。
 */
export interface RunStore {
  create(input: {
    runId: string; requestId: string; userId: string; conversationId: string;
    message: string; clientMessageId: string; mode: "auto" | "report";
    source: "composer" | "report_button"; modelId: string; createdAt: string;
  }): Promise<{ snapshot: RunSnapshotDtoV2; created: boolean }>;
  findById(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined>;
  /** 追加事件：同事务分配 sequence、推进高水位、按事件推导 status；已终态返回 undefined。 */
  appendEvent(userId: string, runId: string, event: RunEventInputDtoV2): Promise<RunStreamEventDtoV2 | undefined>;
  /** SSE 重放源：返回 sequence > afterSequence 的全部事件，升序。 */
  listEvents(userId: string, runId: string, afterSequence: number): Promise<RunStreamEventDtoV2[] | undefined>;
  /** 崩溃恢复：把非终态且早于 before 的 run 标记 interrupted 并补 run_status 事件。 */
  recoverStale(before: string, occurredAt: string): Promise<RunStreamEventDtoV2[]>;
}

export interface RunEventBus {
  publish(event: RunStreamEventDtoV2): void;
  subscribe(runId: string, listener: (event: RunStreamEventDtoV2) => void): () => void;
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
