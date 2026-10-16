import { randomUUID } from "node:crypto";
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import type { RunEventBus } from "../application/run-ports.js";
import type { PubSubTransport } from "@aiagent/database";

/**
 * 跨实例 Run event 总线的信封：在原始事件外裹一层 `originInstanceId`，
 * 用于丢弃「自己发布的回声」，避免同一事件在同一实例被投递两次。
 *
 * 为什么需要：redis pub/sub 会把消息投递给**所有**订阅者，包括发布者自身的订阅连接。
 * 本实例执行 run 时既走本地内存直投（同实例 SSE 订阅者），又会收到自己经 redis 回来的回声；
 * 用 instanceId 比对即可在回声到达时直接丢弃，只保留本地直投那一次。
 */
interface RunEventEnvelope {
  originInstanceId: string;
  event: RunStreamEventDtoV2;
}

/** 按 runId 推导 redis 频道名；频道即 fan-out 单元，粒度到单次 run。 */
function channelForRun(runId: string): string {
  return `aiagent:run_events:${runId}`;
}

/**
 * 创建 Redis 支撑的 Run event 总线，实现跨实例 SSE fan-out。
 *
 * 投递模型（双通道）：
 * 1. **同实例直投**：`publish` 先把事件同步发给本实例的本地内存监听者（SSE 订阅者若在
 *    同一进程，零网络延迟、零序列化开销）。
 * 2. **跨实例广播**：同时把信封序列化后 `transport.publish` 到 redis 频道；其他实例的
 *    订阅连接收到后，解析信封、比对 instanceId，仅当来源非本实例时才转发给本地监听者。
 *
 * 由此保证：不管 SSE 连接落在哪个实例、run 被哪个实例的 worker 执行，订阅者都恰好收到一次。
 *
 * @param transport pub/sub 传输层（通常来自 `createRunEventBusTransportFromEnv`）。
 * @param options.instanceId 本实例唯一标识；缺省用 UUID，仅用于回声去重，不参与路由。
 * @returns 实现 `RunEventBus` 的跨实例总线。
 */
export function createRedisRunEventBus(
  transport: PubSubTransport,
  options: { instanceId?: string } = {}
): RunEventBus {
  const instanceId = options.instanceId ?? randomUUID();
  // 本地内存监听者：同实例 SSE 订阅者的快速通道，不依赖 redis 往返。
  const localListeners = new Map<string, Set<(event: RunStreamEventDtoV2) => void>>();
  // 已向传输层订阅的频道集合，避免重复 SUBSCRIBE（redis 会报错）。
  const subscribedChannels = new Set<string>();

  // 传输层消息回调：只负责把「非自家回声」的交叉实例事件转给本地监听者。
  transport.onMessage((channel, raw) => {
    let envelope: RunEventEnvelope;
    try {
      envelope = JSON.parse(raw) as RunEventEnvelope;
    } catch {
      // 防御：redis 中混入非本系统格式的消息时跳过，不让一条坏消息拖垮整个总线。
      return;
    }
    if (envelope.originInstanceId === instanceId) return; // 自家回声，丢弃。
    const listeners = localListeners.get(envelope.event.runId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(envelope.event);
  });

  /** 确保该 runId 的频道已在传输层订阅（幂等）。 */
  async function ensureSubscribed(runId: string): Promise<void> {
    const channel = channelForRun(runId);
    if (subscribedChannels.has(channel)) return;
    await transport.subscribe(channel);
    subscribedChannels.add(channel);
  }

  return {
    publish(event) {
      // 1) 同实例直投：同步、无网络。
      const local = localListeners.get(event.runId);
      if (local) for (const listener of [...local]) listener(event);
      // 2) 跨实例广播：fire-and-forget，redis 故障只记日志不打断 run 执行。
      const envelope: RunEventEnvelope = { originInstanceId: instanceId, event };
      void Promise.resolve(transport.publish(channelForRun(event.runId), JSON.stringify(envelope))).catch((error: unknown) => {
        console.error("redis run-event publish failed", error);
      });
    },
    subscribe(runId, listener) {
      const listeners = localListeners.get(runId) ?? new Set<() => void>();
      listeners.add(listener);
      localListeners.set(runId, listeners);
      // 订阅是异步的（redis 连接），但订阅行为本身不阻塞 SSE 建立；
      // 在订阅完成前到达的跨实例事件会暂由 redis 缓冲（pub/sub 不持久化，极端竞态下
      // 由 SSE 的 completeCatchUp 二次查库兜底，不会丢事件）。
      void ensureSubscribed(runId).catch((error: unknown) => {
        console.error("redis run-event subscribe failed", error);
      });
      return () => {
        const set = localListeners.get(runId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) {
          localListeners.delete(runId);
          const channel = channelForRun(runId);
          subscribedChannels.delete(channel);
          // 最后一个监听者离开才退订，避免抖动；传输层 unsubscribe 同样是幂等的。
          void Promise.resolve(transport.unsubscribe(channel)).catch((error: unknown) => {
            console.error("redis run-event unsubscribe failed", error);
          });
        }
      };
    }
  };
}
