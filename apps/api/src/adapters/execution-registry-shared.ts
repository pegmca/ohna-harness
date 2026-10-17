import type { RunCancelSignal, RunCancelStore, RunExecutionRegistry } from "../application/run-ports.js";

/**
 * 跨实例执行注册表：本地仍用 AbortController 承接 agent loop 的 signal 契约，
 * 但取消意图通过共享 `RunCancelSignal`（Redis pub/sub 或进程内）传播，
 * 使得落在实例 B 的取消请求也能中断实例 A 上正在执行的 run。
 *
 * 设计要点（修复原进程内注册表的隐含假设）：
 * - 原 `AbortController` 与创建它的进程绑定，多实例下"取消请求落在 B、run 执行在 A"
 *   时 signal 无法触达。这里把"取消意图"与"取消动作"解耦：
 *   `requestCancel` 写持久化标记（queued 竞态兜底）+ 广播即时信号（在途 run 即时中断）；
 *   各实例在 `create` 时订阅该 run 的取消事件，收到后本地 `abort()`。
 * - `create` 幂等：同一 runId 重复创建返回既有控制器，避免多 worker / 重试重复订阅。
 * - 执行实例不固定：worker claim 后 `execute` 才真正运行，可能与收到 create 请求的实例不同，
 *   因此 `create` 既在 `run-service.create`（同实例 queued 语义）也可在 `execute`（跨实例兜底）调用。
 *
 * @param options.cancelSignal 跨实例取消信号传输层（Redis 或进程内）。
 * @param options.cancelStore 可选持久化取消标记（DB），覆盖订阅前已取消的 queued 竞态。
 * @returns 实现 `RunExecutionRegistry` 的跨实例注册表。
 */
export function createSharedExecutionRegistry(options: {
  cancelSignal: RunCancelSignal;
  cancelStore?: RunCancelStore;
}): RunExecutionRegistry {
  // 本地控制器表：run 实际执行所在实例持有，承接 agent loop 的 signal。
  const entries = new Map<string, { controller: AbortController; unsubscribe: () => void }>();

  function create(runId: string): AbortController {
    const existing = entries.get(runId);
    if (existing) return existing.controller;
    const controller = new AbortController();
    // 订阅共享取消信号：任何实例 requestCancel 后本地中断。
    const unsubscribe = options.cancelSignal.subscribe(runId, () => controller.abort());
    entries.set(runId, { controller, unsubscribe });
    return controller;
  }

  function get(runId: string): AbortController | undefined {
    return entries.get(runId)?.controller;
  }

  function del(runId: string): void {
    const entry = entries.get(runId);
    if (!entry) return;
    entry.unsubscribe();
    entries.delete(runId);
  }

  function list(): string[] {
    return [...entries.keys()];
  }

  function requestCancel(runId: string): void | Promise<void> {
    // 先落持久化标记（queued 竞态兜底），再广播即时信号（在途 run 即时中断）。
    // 两条路径都防御式收敛为 Promise，便于上层 await（单实例内存实现同步返回也不影响）。
    const persist = options.cancelStore ? options.cancelStore.markCancelled(runId) : undefined;
    const broadcast = options.cancelSignal.publish(runId);
    if (persist || broadcast) {
      return Promise.all([Promise.resolve(persist), Promise.resolve(broadcast)]).then(() => undefined);
    }
    return undefined;
  }

  return { create, get, delete: del, list, requestCancel };
}
