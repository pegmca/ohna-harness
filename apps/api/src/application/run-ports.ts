import type { AgentRunCreateRequestDto, RunEventInputDtoV2, RunSnapshotDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";

/**
 * worker claim 后获得的 run 上下文：快照 + 原始请求 + 用户。
 * worker 据此重建 execute 所需的全部参数，无需跨进程传递 request。
 */
export interface ClaimedRun {
  snapshot: RunSnapshotDtoV2;
  request: AgentRunCreateRequestDto;
  userId: string;
}

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
    /** create 时的完整请求快照，worker claim 后据此重建执行上下文。 */
    requestPayload: AgentRunCreateRequestDto;
  }): Promise<{ snapshot: RunSnapshotDtoV2; created: boolean }>;
  findById(userId: string, runId: string): Promise<RunSnapshotDtoV2 | undefined>;
  /** 追加事件：同事务分配 sequence、推进高水位、按事件推导 status；已终态返回 undefined。 */
  appendEvent(userId: string, runId: string, event: RunEventInputDtoV2): Promise<RunStreamEventDtoV2 | undefined>;
  /** SSE 重放源：返回 sequence > afterSequence 的全部事件，升序。 */
  listEvents(userId: string, runId: string, afterSequence: number): Promise<RunStreamEventDtoV2[] | undefined>;
  /** 崩溃恢复：把非终态且早于 before 的 run 标记 interrupted 并补 run_status 事件。 */
  recoverStale(before: string, occurredAt: string): Promise<RunStreamEventDtoV2[]>;
  /**
   * worker 抢占下一个 queued run：`FOR UPDATE SKIP LOCKED` + 设 lease_until + claimed_by + status='running'。
   * 原子事务保证同一 run 只被一个 worker claim；无 queued run 时返回 undefined。
   *
   * @param workerId 当前 worker 的进程级唯一标识。
   * @param leaseDurationMs 租约时长（毫秒），到期后可被其他 worker 重新 claim。
   * @returns 被领取的 run 上下文；无可用 run 时为 undefined。
   */
  claimNext(workerId: string, leaseDurationMs: number): Promise<ClaimedRun | undefined>;
  /**
   * 续期租约：只有 claimed_by 匹配且 lease 未过期的 run 才能续期。
   *
   * @returns 续期成功为 true；租约已丢失（被其他 worker 重新 claim 或已终态）为 false。
   */
  renewLease(runId: string, workerId: string, leaseDurationMs: number): Promise<boolean>;
  /**
   * 释放租约：把 running 但非终态的 run 重置为 queued（worker 主动放弃或异常退出）。
   * 正常终态不需要调用 release——appendEvent 推导终态后 lease 自动失效。
   */
  release(runId: string, workerId: string): Promise<void>;
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
