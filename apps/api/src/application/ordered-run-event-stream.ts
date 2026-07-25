import type { AgentRunStreamEventDto } from "@aiagent/types";

export interface OrderedRunEventStream {
  replay(events: AgentRunStreamEventDto[]): Promise<void>;
  acceptLive(event: AgentRunStreamEventDto): Promise<void>;
  completeCatchUp(events: AgentRunStreamEventDto[]): Promise<void>;
  isClosed(): boolean;
}

export interface OrderedRunEventStreamDependencies {
  afterSequence: number;
  loadAfter(sequence: number): Promise<AgentRunStreamEventDto[]>;
  write(event: AgentRunStreamEventDto): void;
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
  const pending = new Map<number, AgentRunStreamEventDto>();
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
  function buffer(events: AgentRunStreamEventDto[]): void {
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
 * 判断 canonical event 是否使 Run 进入终态。
 *
 * @param event Run event。
 * @returns 是否应在发送该事件后关闭 SSE。
 */
export function isTerminalRunEvent(event: AgentRunStreamEventDto): boolean {
  if (event.type === "run_result" || event.type === "run_error") return true;
  return event.type === "run_status" && isTerminalRunStatus(event.status);
}

/**
 * 判断 Run snapshot 状态是否为不可回退终态。
 *
 * @param status Run 状态。
 * @returns 是否应关闭 SSE。
 */
export function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
