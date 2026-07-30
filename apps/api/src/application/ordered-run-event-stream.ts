import type { RunSnapshotDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";

export interface OrderedRunEventStream {
  replay(events: RunStreamEventDtoV2[]): Promise<void>;
  acceptLive(event: RunStreamEventDtoV2): Promise<void>;
  completeCatchUp(events: RunStreamEventDtoV2[]): Promise<void>;
  isClosed(): boolean;
}

export interface OrderedRunEventStreamDependencies {
  afterSequence: number;
  loadAfter(sequence: number): Promise<RunStreamEventDtoV2[]>;
  write(event: RunStreamEventDtoV2): void;
  close(): void;
}

/**
 * 创建严格按连续 sequence 输出的 Run event stream。
 *
 * 初次 replay 后仍保持 catch-up 模式，此时 live 事件只进入缓冲区。二次查询完成后，
 * catch-up 与 live buffer 会按 sequence 合并，再切换到直接 live。若直接 live 仍观察到
 * 缺口，则以当前水位回查数据库，避免事务提交后的进程内 publish 调度乱序造成遗漏。
 *
 * @param dependencies 持久事件查询、SSE 写入与关闭回调。
 * @returns 有序事件流控制器。
 */
export function createOrderedRunEventStream(
  dependencies: OrderedRunEventStreamDependencies
): OrderedRunEventStream {
  const pending = new Map<number, RunStreamEventDtoV2>();
  let lastSequence = dependencies.afterSequence;
  let catchingUp = true;
  let closed = false;
  let operation: Promise<void> = Promise.resolve();

  /** @param task 需要串行执行的 drain 操作。 @returns 当前操作完成 Promise。 */
  function schedule(task: () => Promise<void> | void): Promise<void> {
    const next = operation.then(task);
    operation = next.catch(() => undefined);
    return next;
  }

  /** @param events 待合并事件。 @returns 无返回值。 */
  function buffer(events: RunStreamEventDtoV2[]): void {
    for (const event of events) {
      if (event.sequence > lastSequence) pending.set(event.sequence, event);
    }
  }

  /**
   * 仅发送水位后的连续事件；高 sequence 会留在 buffer，等待缺口补齐。
   *
   * @returns 无返回值。
   */
  function drainContinuous(): void {
    while (!closed) {
      const next = pending.get(lastSequence + 1);
      if (!next) return;
      pending.delete(next.sequence);
      dependencies.write(next);
      lastSequence = next.sequence;
      if (isTerminalRunEvent(next)) {
        closed = true;
        dependencies.close();
      }
    }
  }

  /**
   * 从持久层补齐当前水位后的事件，并再次 drain。
   *
   * @returns 补查完成 Promise。
   */
  async function fillGapFromStore(): Promise<void> {
    if (closed) return;
    buffer(await dependencies.loadAfter(lastSequence));
    drainContinuous();
  }

  return {
    replay(events) {
      return schedule(() => {
        buffer(events);
        drainContinuous();
      });
    },
    acceptLive(event) {
      buffer([event]);
      if (catchingUp || closed) return operation;
      return schedule(async () => {
        drainContinuous();
        if (pending.size > 0 && !closed) await fillGapFromStore();
      });
    },
    completeCatchUp(events) {
      return schedule(async () => {
        buffer(events);
        catchingUp = false;
        drainContinuous();
        if (pending.size > 0 && !closed) await fillGapFromStore();
      });
    },
    isClosed: () => closed
  };
}

/**
 * 判断 canonical event 是否使 Run 进入终态（SSE 在该事件后关闭）。
 * 新协议下终态事件为 agent_end（正常/失败/取消收尾）、run_error（执行层异常）
 * 与 run_status 的 interrupted（崩溃恢复）。
 *
 * @param event Run event。
 * @returns 是否应在发送该事件后关闭 SSE。
 */
export function isTerminalRunEvent(event: RunStreamEventDtoV2): boolean {
  if (event.type === "agent_end" || event.type === "run_error") return true;
  if (event.type !== "run_status") return false;
  const payload = event.payload as { status?: string };
  return isTerminalRunStatus(payload.status ?? "");
}

/**
 * 判断 Run snapshot 状态是否为不可回退终态。
 *
 * @param status Run 状态。
 * @returns 是否应关闭 SSE。
 */
export function isTerminalRunStatus(status: RunSnapshotDtoV2["status"] | string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}
