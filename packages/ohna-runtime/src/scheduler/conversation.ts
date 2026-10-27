/**
 * 会话级调度器：同一 conversation 的 run 提交串行 FIFO，不同 conversation 并行。
 *
 * 调度边界放在 runtime 组合根而不是 RunManager 内部：`createRun` 仍是单次创建/执行
 * 的领域操作，而「同一会话是否允许立即创建」是宿主级策略。幂等键为跨进程协议的
 * requestId，内存态缓存与 promise 链同生命周期（runtime 单实例）。
 */
import type { RunStartResultDto } from "@aiagent/types";
import type { StartRunInput } from "../runtime.js";

/** 会话提交结果：start 的产物与 runId 组合，便于取消当前执行时定位。 */
interface Submission {
  result: RunStartResultDto;
  runId: string;
}

/** 会话串行调度器接口。 */
export interface ConversationScheduler {
  submit(input: StartRunInput, start: () => Promise<RunStartResultDto>): Promise<RunStartResultDto>;
  cancel(runId: string): Promise<void>;
}

/**
 * 创建 conversation 级 FIFO 调度器。
 *
 * @param dependencies 调度器依赖。
 * @param dependencies.cancelRun 取消底层 run 的函数。
 * @param dependencies.waitTerminal 等待 run 进入终态的函数。
 * @returns 调度器实例。
 */
export function createConversationScheduler(dependencies: {
  cancelRun: (runId: string) => Promise<unknown> | unknown;
  waitTerminal: (runId: string) => Promise<void>;
}): ConversationScheduler {
  const chains = new Map<string, Promise<void>>();
  const accepted = new Map<string, Submission>();
  // 已受理但尚未落库的在途提交：并发的相同 requestId 在 start() 返回前都会命中这里，
  // 避免两个同 id 的提交各排队一次而创建两个 run（accepted 只在 start 返回后才写入）。
  const inflight = new Map<string, Promise<RunStartResultDto>>();

  /**
   * 把一次提交接到所属会话的 promise 链尾部。
   *
   * `admitted` 在 start() 返回后立即 resolve（调用方不用等 run 结束）；
   * `done` 在 run 终态后 resolve，作为下一个提交的启动闸门。
   *
   * @param conversationId 会话 id。
   * @param start 创建并启动 run。
   * @returns 本次提交的受理结果与链尾。
   */
  const enqueue = (
    conversationId: string,
    requestId: string | undefined,
    start: () => Promise<RunStartResultDto>
  ): { admitted: Promise<RunStartResultDto>; done: Promise<void> } => {
    const previous = chains.get(conversationId) ?? Promise.resolve();
    let resolveAdmitted!: (result: RunStartResultDto) => void;
    let rejectAdmitted!: (error: unknown) => void;
    const admitted = new Promise<RunStartResultDto>((resolve, reject) => {
      resolveAdmitted = resolve;
      rejectAdmitted = reject;
    });
    const done = previous
      .then(async () => {
        const result = await start();
        if (requestId) accepted.set(requestId, { result, runId: result.accepted.runId });
        resolveAdmitted(result);
        await dependencies.waitTerminal(result.accepted.runId);
      })
      .catch((error: unknown) => {
        rejectAdmitted(error);
      })
      .finally(() => {
        if (chains.get(conversationId) === done) chains.delete(conversationId);
      });
    chains.set(conversationId, done);
    return { admitted, done };
  };

  return {
    async submit(input, start) {
      const requestId = input.requestId;
      if (requestId) {
        // 已受理（start 已返回）优先；其次是在途提交，二者都直接复用既有结果。
        const existing = accepted.get(requestId);
        if (existing) return existing.result;
        const pending = inflight.get(requestId);
        if (pending) return pending;
      }
      const { admitted } = enqueue(input.conversationId, requestId, start);
      if (requestId) {
        inflight.set(requestId, admitted);
        void admitted.finally(() => {
          if (inflight.get(requestId) === admitted) inflight.delete(requestId);
        });
      }
      return admitted;
    },
    async cancel(runId) {
      await dependencies.cancelRun(runId);
    }
  };
}
