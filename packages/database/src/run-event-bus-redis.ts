import { createClient, type RedisClientType } from "redis";

/**
 * 跨实例事件总线的传输层端口（与具体 Redis 客户端解耦，便于测试用内存替身）。
 *
 * Run event 的 fan-out 只需「按频道发布 / 订阅 / 接收消息」三种能力，
 * 本接口刻意收窄到 pub/sub 语义，避免把 redis 全量命令暴露给上层。
 * 上层 {@link createRedisRunEventBus} 组合本地内存监听 + 此传输层实现跨进程广播。
 */
export interface PubSubTransport {
  /** 向某个频道发布一条已序列化的消息；可异步（redis 网络往返）。 */
  publish(channel: string, message: string): Promise<void> | void;
  /** 订阅某个频道（幂等：重复订阅同一频道不应抛错）。 */
  subscribe(channel: string): Promise<void> | void;
  /** 退订某个频道。 */
  unsubscribe(channel: string): Promise<void> | void;
  /** 注册消息回调；传输层收到任意频道消息时转发 `(channel, message)`。 */
  onMessage(handler: (channel: string, message: string) => void): void;
  /** 关闭底层连接（已关闭时为 no-op）。 */
  quit(): Promise<void> | void;
}

/**
 * 基于 node-redis v4 的 pub/sub 传输实现。
 *
 * 设计要点：
 * - **发布与订阅使用两条独立连接**：redis 订阅连接进入 subscriber 模式后只能执行
 *   订阅类命令，不能混用普通命令；分开两条连接可避免「在订阅连接上 publish 被拒」的
 *   RESP 限制，也让 publish 与接收解耦。
 * - **懒连接**：组合根在模块顶层同步构建，不能在此 `await`；首次命令前共享一次 `connect()`。
 * - **self-echo 由上层去重**：同一实例的 sub 连接会收到自己 pub 连接发出的消息，
 *   上层 {@link createRedisRunEventBus} 用 `instanceId` 信封丢弃自家回声，避免重复投递。
 *
 * @param redisUrl Redis 连接串（来自 `REDIS_URL`）。
 * @returns pub/sub 传输层。
 */
export function createRedisPubSubTransport(redisUrl: string): PubSubTransport {
  // 发布连接：执行普通 PUBLISH 命令，不参与订阅。
  const pubClient: RedisClientType = createClient({ url: redisUrl });
  // 订阅连接：进入 subscriber 模式，只承载 SUBSCRIBE/UNSUBSCRIBE 与 message 事件。
  const subClient: RedisClientType = createClient({ url: redisUrl });
  // 单实例错误吞掉并打日志：redis 抖动不应让 API 进程崩溃，事件总线降级为「尽力而为」。
  pubClient.on("error", (error: unknown) => { console.error("redis run-event pub client error", error); });
  subClient.on("error", (error: unknown) => { console.error("redis run-event sub client error", error); });

  let pubConnect: Promise<unknown> | undefined;
  let subConnect: Promise<unknown> | undefined;
  const ensurePub = (): Promise<void> => {
    if (pubClient.isReady) return Promise.resolve();
    if (!pubConnect) {
      pubConnect = pubClient.connect().catch((error: unknown) => { pubConnect = undefined; throw error; });
    }
    return pubConnect.then(() => undefined);
  };
  const ensureSub = (): Promise<void> => {
    if (subClient.isReady) return Promise.resolve();
    if (!subConnect) {
      subConnect = subClient.connect().catch((error: unknown) => { subConnect = undefined; throw error; });
    }
    return subConnect.then(() => undefined);
  };

  const subscribed = new Set<string>();
  let messageHandler: ((channel: string, message: string) => void) | undefined;
  // 收到订阅消息时统一转发给上层 handler；频道路由交给上层按 runId 分发。
  // node-redis v4 的 subscribe 必须随频道传入监听回调，故在每次订阅时绑定同一转发逻辑。
  const forward = (message: string, channel: string): void => { messageHandler?.(channel, message); };

  return {
    async publish(channel, message) {
      await ensurePub();
      await pubClient.publish(channel, message);
    },
    async subscribe(channel) {
      await ensureSub();
      // 重复订阅同一频道会让 redis 返回错误，这里用集合幂等化。
      if (subscribed.has(channel)) return;
      // subscribe 必须带监听回调（node-redis v4 类型要求）；回调只做统一转发。
      await subClient.subscribe(channel, forward);
      subscribed.add(channel);
    },
    async unsubscribe(channel) {
      if (!subscribed.has(channel)) return;
      subscribed.delete(channel);
      await subClient.unsubscribe(channel);
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    async quit() {
      // 两条连接独立关闭；已关闭时 isOpen 为 false，quit 是 no-op。
      if (pubClient.isOpen) await pubClient.quit();
      if (subClient.isOpen) await subClient.quit();
    }
  };
}

/**
 * 按环境变量选择事件总线传输层，作为 composition root 的注入边界（与附件 store 同一策略）。
 *
 * 存在 `REDIS_URL` → 走 Redis pub/sub（支持多实例 fan-out）；
 * 未配置 → 返回 `transport: undefined`，上层退化为进程内内存总线（单实例 demo / 测试）。
 *
 * 该函数**同步返回**：组合根在模块顶层构建 app，不能在此 await 连接。
 *
 * @returns 传输层（可能为空）与关闭函数；close 仅在已连接时 quit。
 */
export function createRunEventBusTransportFromEnv(): { transport?: PubSubTransport; close: () => Promise<void> } {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return { transport: undefined, close: async () => {} };
  }
  const transport = createRedisPubSubTransport(redisUrl);
  // transport.quit() 返回 `void | Promise<void>`，用 async 统一收敛为 Promise<void>。
  return { transport, close: async () => { await transport.quit(); } };
}
