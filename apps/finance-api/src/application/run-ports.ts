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
   * 写入执行检查点：每轮提交后记录 (turn, lastEventSequence)，支持从最近检查点续跑。
   * 仅追加覆盖（同 run 只保留最新检查点），不影响事件溯源与状态机。
   *
   * @param userId 当前用户（所有权校验）。
   * @param runId Run 标识。
   * @param checkpoint 检查点载荷（轮数 + 事件高水位）。
   */
  setCheckpoint(userId: string, runId: string, checkpoint: RunSnapshotDtoV2["lastCheckpoint"]): Promise<void>;
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
  /**
   * 请求取消某 run（跨实例语义）：写持久化取消标记（queued 竞态兜底）并广播即时信号，
   * 使正在任意实例上执行该 run 的 loop 通过本地 AbortController 收到中断。
   * 替代原进程内 `get(runId)?.abort()`——后者只能中断创建控制器所在进程内的 run。
   *
   * @param runId 目标 run 标识。
   * @returns 广播（可能含落库）的 Promise；单实例内存实现可同步返回。
   */
  requestCancel(runId: string): void | Promise<void>;
}

/**
 * 跨实例取消信号传输层（与具体 Redis 客户端解耦，便于测试用内存替身）。
 *
 * 取消语义与 SSE 事件总线复用同一「发布/订阅」抽象：某实例请求取消时 `publish(runId)`，
 * 正在执行该 run 的实例通过 `subscribe` 收到信号并中断本地 AbortController。
 * 多实例下"取消请求落在实例 B、run 执行在实例 A"时，正是靠这一层把中断意图送达 A。
 */
export interface RunCancelSignal {
  /** 订阅某 run 的取消事件；返回取消订阅函数（幂等，重复订阅同一 runId 不抛错）。 */
  subscribe(runId: string, listener: () => void): () => void;
  /** 广播某 run 的取消请求（可异步）。语义为 fire-and-forget：redis 抖动不影响 run 执行。 */
  publish(runId: string): Promise<void> | void;
}

/**
 * 取消标记持久化端口：覆盖"execute 订阅前已被取消"的 queued 竞态。
 *
 * 进程内 pub/sub 无法回放历史消息——若取消广播先于 worker claim 后 execute 的订阅到达，
 * 该次取消会丢失。用一张小表持久记录取消意图，execute 启动时回查即可兜底。
 * 与 `RunCancelSignal` 互补：signal 负责在途 run 的即时中断，store 负责 queued run 的确定性兜底。
 */
export interface RunCancelStore {
  /** 记录某 run 已被请求取消（幂等：重复标记不报错）。 */
  markCancelled(runId: string): Promise<void> | void;
  /** @returns 该 run 是否已被请求取消。 */
  isCancelled(runId: string): Promise<boolean> | boolean;
}
