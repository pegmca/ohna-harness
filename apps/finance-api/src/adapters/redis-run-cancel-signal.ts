import type { PubSubTransport } from "@aiagent/database";
import type { RunCancelSignal } from "../application/run-ports.js";

/** 按 runId 推导 redis 频道名；频道即取消广播单元，粒度到单次 run。 */
function channelForCancel(runId: string): string {
  return `aiagent:run_cancel:${runId}`;
}

/**
 * 基于 Redis pub/sub 的跨实例取消信号。
 *
 * 复用 SSE 事件总线的 `PubSubTransport` 抽象（发布/订阅两条连接分离），把"取消 runId"广播到所有实例；
 * 每个实例在 `create` 时按 runId 订阅，收到后中断本地 AbortController。这样"取消请求落在实例 B、
 * run 执行在实例 A"时，A 也能真正中断。
 *
 * 与 SSE 总线不同，这里不需要 instanceId 回声去重：取消是"至少一次"的触发信号，
 * 同一实例收到自家回声也只是重复 abort（已是 aborted 的控制器再次 abort 是 no-op），无副作用。
 *
 * @param transport pub/sub 传输层（来自 `createRunEventBusTransportFromEnv`）。
 * @returns 实现 `RunCancelSignal` 的跨实例取消信号。
 */
export function createRedisRunCancelSignal(transport: PubSubTransport): RunCancelSignal {
  // 每个 runId 的本地监听者集合（同实例内多 subscriber 去重）。
  const localListeners = new Map<string, Set<() => void>>();
  const subscribedChannels = new Set<string>();

  transport.onMessage((channel, raw) => {
    // 频道即 runId 信封：直接取频道对应的监听者集合转发。
    const runId = runIdFromChannel(channel);
    if (!runId) return;
    const listeners = localListeners.get(runId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  });

  function runIdFromChannel(channel: string): string | undefined {
    const prefix = "aiagent:run_cancel:";
    return channel.startsWith(prefix) ? channel.slice(prefix.length) : undefined;
  }

  async function ensureSubscribed(runId: string): Promise<void> {
    const channel = channelForCancel(runId);
    if (subscribedChannels.has(channel)) return;
    await transport.subscribe(channel);
    subscribedChannels.add(channel);
  }

  return {
    subscribe(runId, listener) {
      const listeners = localListeners.get(runId) ?? new Set<() => void>();
      listeners.add(listener);
      localListeners.set(runId, listeners);
      // 订阅是异步的（redis 连接），但订阅行为不阻塞；极端竞态下由 RunCancelStore 的启动回查兜底。
      void ensureSubscribed(runId).catch((error: unknown) => {
        console.error("redis run-cancel subscribe failed", error);
      });
      return () => {
        const set = localListeners.get(runId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) {
          localListeners.delete(runId);
          const channel = channelForCancel(runId);
          subscribedChannels.delete(channel);
          void Promise.resolve(transport.unsubscribe(channel)).catch((error: unknown) => {
            console.error("redis run-cancel unsubscribe failed", error);
          });
        }
      };
    },
    publish(runId) {
      // fire-and-forget：redis 故障只记日志，不阻断 run 执行（取消失败由 RunCancelStore 兜底）。
      void Promise.resolve(transport.publish(channelForCancel(runId), runId)).catch((error: unknown) => {
        console.error("redis run-cancel publish failed", error);
      });
    }
  };
}
