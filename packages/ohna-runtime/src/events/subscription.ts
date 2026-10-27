/**
 * runtime 事件订阅登记表。
 *
 * 该模块只维护 subscriptionId → listener 的映射，不感知 run 生命周期与 HTTP 传输。
 * replay/live 的顺序合并由 `events/replay.ts` 完成；退订与显式移除都是幂等的。
 */
import { randomUUID } from "node:crypto";
import type { RunStreamEventDtoV2 } from "@aiagent/types";

/** runtime 订阅句柄。 */
export interface Subscription {
  subscriptionId: string;
  unsubscribe(): void;
}

/** 订阅选项。 */
export interface SubscribeOptions {
  afterSequence?: number;
  onEvent: (event: RunStreamEventDtoV2) => void;
}

/**
 * 创建订阅登记表（subscriptionId → listener）。
 *
 * @returns 登记 / 查询 / 显式移除 / 关闭能力。
 */
export function createSubscriptionRegistry(): {
  register(
    listener: (event: RunStreamEventDtoV2) => void
  ): Subscription;
  get(subscriptionId: string): ((event: RunStreamEventDtoV2) => void) | undefined;
  remove(subscriptionId: string): void;
  close(): void;
} {
  const subscriptions = new Map<string, (event: RunStreamEventDtoV2) => void>();
  let closed = false;

  /**
   * 登记一个 listener 并生成订阅 id。
   *
   * @param listener 事件回调。
   * @returns 订阅句柄（unsubscribe 幂等）。
   */
  const register = (
    listener: (event: RunStreamEventDtoV2) => void
  ): Subscription => {
    const subscriptionId = randomUUID();
    let unsubscribed = false;
    const subscription: Subscription = {
      subscriptionId,
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        subscriptions.delete(subscriptionId);
      }
    };
    // 已关闭的登记表不再接纳新订阅（避免运行时长尾投递到失效入口）。
    if (!closed) subscriptions.set(subscriptionId, listener);
    return subscription;
  };

  return {
    register,
    get: (subscriptionId: string) => subscriptions.get(subscriptionId),
    /**
     * 按 id 直接移除订阅（不依赖 Subscription 句柄，用于 run 终态后清理原子订阅）。
     *
     * @param subscriptionId 订阅 id。
     */
    remove: (subscriptionId: string) => {
      subscriptions.delete(subscriptionId);
    },
    close: () => {
      closed = true;
      subscriptions.clear();
    }
  };
}
