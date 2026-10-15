/**
 * Run worker loop：从队列消费 queued run 并执行。
 *
 * 把"入队"与"执行"解耦——HTTP 请求只负责 store.create()（落 status='queued'），
 * worker loop 定时 poll claimNext 抢占并执行。崩溃后 lease 过期的 run 被 recoverStale
 * 重置为 queued，下次 poll 被其他 worker 重新 claim，实现 at-least-once 语义。
 *
 * 当前部署在 API 进程内启动（单进程 worker loop）；架构上已为多进程/独立 worker 进程
 * 预留：claimNext 用 `FOR UPDATE SKIP LOCKED` 保证多 worker 无竞争。
 */

import type { AgentRunCreateRequestDto } from "@aiagent/types";
import type { RunStore } from "./run-ports.js";

/** worker 依赖注入：存储端口 + 执行回调 + 轮询/续期参数。 */
export interface RunWorkerDependencies {
  /** Run 存储端口，提供 claimNext / renewLease / release。 */
  store: RunStore;
  /**
   * 执行单次 run（复用 run-service 的 execute 逻辑）。
   * worker claim 成功后调用此回调，把 claim 得到的 request 传入。
   *
   * @param runId Run 标识。
   * @param request 原始创建请求（从 request_payload 重建）。
   * @param userId 用户标识。
   */
  execute: (runId: string, request: AgentRunCreateRequestDto, userId: string) => Promise<void>;
  /** 当前 worker 的进程级唯一标识（UUID），用于 claim 的 claimed_by 字段。 */
  workerId: string;
  /** 轮询间隔（毫秒），无 queued run 时按此间隔重试。 */
  pollIntervalMs: number;
  /** 租约时长（毫秒），claim 后 lease_until = now() + leaseDurationMs。 */
  leaseDurationMs: number;
  /** 续期间隔（毫秒），执行中按此频率续期；必须 < leaseDurationMs/2。 */
  renewIntervalMs: number;
}

/** Run worker 接口：启动 / 停止 / 状态查询。 */
export interface RunWorker {
  /** 启动轮询循环。 */
  start(): void;
  /** 停止轮询，等待当前 run 执行结束（有限等待）。 */
  stop(): Promise<void>;
  /** @returns worker 是否正在运行。 */
  isRunning(): boolean;
}

/**
 * 创建 Run worker loop。
 *
 * @param dependencies 注入依赖。
 * @returns Run worker 控制器。
 */
export function createRunWorker(dependencies: RunWorkerDependencies): RunWorker {
  let running = false;
  let busy = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // 当前正在执行的 run 的续期定时器；执行结束后清除。
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  // 当前正在执行的 run 的完成 Promise；stop() 时等待其结束（有限等待）。
  let currentRunSettled: Promise<void> = Promise.resolve();

  /**
   * 抢占并执行一个 run。
   * claim 成功后启动续期定时器，执行结束（正常/异常）后清除。
   * busy 守卫保证单 worker 串行执行（天然维持 per-conversation 串行，多 worker 时由 claim 的 SKIP LOCKED 保证）。
   *
   * @returns 完成后 resolve。
   */
  async function pollOnce(): Promise<void> {
    if (!running || busy) return;
    busy = true;
    try {
      let claimed;
      try {
        claimed = await dependencies.store.claimNext(dependencies.workerId, dependencies.leaseDurationMs);
      } catch {
        // claim 失败（DB 不可用等）不终止 worker loop，下次 poll 重试。
        return;
      }
      if (!claimed) return;

      const { snapshot, request, userId } = claimed;

      // 启动续期定时器：执行期间定时 renewLease，防止长 run 租约过期被其他 worker 重新 claim。
      renewTimer = setInterval(() => {
        void dependencies.store.renewLease(snapshot.runId, dependencies.workerId, dependencies.leaseDurationMs)
          .catch(() => undefined);
      }, dependencies.renewIntervalMs);

      // 把 execute 包裹为 settled Promise，供 stop() 等待。
      currentRunSettled = (async () => {
        try {
          await dependencies.execute(snapshot.runId, request, userId);
        } catch {
          // execute 内部已有 try/catch 落 run_error；此处兜底防止异常逃逸终止 worker loop。
        } finally {
          clearInterval(renewTimer);
          renewTimer = undefined;
        }
      })();
      await currentRunSettled;
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // 立即 poll 一次（不等待第一个 interval），减少首 run 延迟。
      void pollOnce();
      pollTimer = setInterval(() => { void pollOnce(); }, dependencies.pollIntervalMs);
    },

    async stop() {
      running = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
      if (renewTimer) { clearInterval(renewTimer); renewTimer = undefined; }
      // 等待当前 run 执行结束（有限等待 5s，避免 shutdown 卡死）。
      await Promise.race([
        currentRunSettled,
        new Promise<void>((resolve) => setTimeout(resolve, 5000))
      ]);
    },

    isRunning: () => running
  };
}
