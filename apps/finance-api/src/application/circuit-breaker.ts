/**
 * LLM provider 调用熔断（runtime SLO 熔断）。
 *
 * 背景：run 的 LLM 调用由 agentLoop 经 `streamFn` 完成，按契约失败编码进事件流
 * （stopReason="error" / 流以 error 事件收尾），并不主动 throw。本熔断器包装 `streamFn`：
 * - 观察每个流是否以 error 事件收尾（或抛异常）→ 记为一次失败；
 * - 连续失败达到阈值则跳闸 OPEN，冷却窗口内对后续调用快速失败（不继续打已故障的 provider）；
 * - 冷却结束后进入 HALF-OPEN，放一次探查，成功则闭合、失败则再次 OPEN。
 *
 * 触发快速失败时抛出结构化错误，由 agentLoop → run_error 收尾为 failed，避免 at-least-once 重排
 * 在 provider 持续故障时反复重试放大故障。
 *
 * 此为实例级共享熔断器（不区分 provider）；生产可扩展为按 provider 维度隔离。
 */

/** 熔断器配置（env 驱动）。 */
export interface CircuitBreakerOptions {
  /** 连续失败达到该值即跳闸；默认 5。 */
  failureThreshold?: number;
  /** 跳闸后冷却窗口（毫秒），窗口内快速失败；默认 30000。 */
  cooldownMs?: number;
}

type State = "closed" | "open" | "half-open";

/**
 * 创建 LLM provider 熔断器。
 *
 * @param options 跳闸阈值与冷却窗口（env 驱动，缺省给出保守默认）。
 * @returns 熔断器。
 */
export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = options.failureThreshold && options.failureThreshold > 0 ? options.failureThreshold : 5;
  const cooldownMs = options.cooldownMs && options.cooldownMs > 0 ? options.cooldownMs : 30_000;
  let state: State = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;
  return {
    /** @returns 当前状态（closed/open/half-open），便于观测与测试。 */
    getState(): State {
      // 冷却结束且处于 open 时，惰性转为 half-open（下次 attempt 放行一次探查）。
      if (state === "open" && Date.now() >= openedAt + cooldownMs) {
        state = "half-open";
      }
      return state;
    },
    /** @returns 是否允许本次调用：closed 始终允许；open 冷却内拒绝；half-open 放行一次。 */
    canAttempt(): boolean {
      if (state === "open") {
        if (Date.now() >= openedAt + cooldownMs) {
          state = "half-open";
          return true;
        }
        return false;
      }
      return true;
    },
    /** 记录一次成功：重置连续失败计数并闭合。 */
    recordSuccess(): void {
      consecutiveFailures = 0;
      state = "closed";
    },
    /** 记录一次失败：累计，达阈值则跳闸 OPEN 并记录跳闸时刻。 */
    recordFailure(): void {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        // 仅在尚未处于 open 时（closed→open 或 half-open 探针失败→重新 open）记录跳闸时刻；
        // 若已处于 open 则保留原始 openedAt，避免重复失败把冷却窗口不断后推、导致 half-open 探针永不触发。
        // （快速失败路径已不再调用本方法，这里作为防御性兜底。）
        if (state !== "open") {
          state = "open";
          openedAt = Date.now();
        }
      }
    }
  };
}

/** 熔断器运行时接口（与实现解耦，便于测试注入）。 */
export interface CircuitBreaker {
  getState(): "closed" | "open" | "half-open";
  canAttempt(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

/**
 * 用熔断器包装 `streamFn`：OPEN 状态快速失败（抛错），否则包装返回的事件流，
 * 在其以 error 事件收尾或抛异常时记录失败、正常收尾时记录成功。
 *
 * 关键契约：agentLoop 依赖 `AssistantMessageEventStream` 的 `result()` 方法取最终消息，
 * 因此包装后的返回值必须同时具备「可异步迭代」与「`result()` 方法」——绝不能像裸
 * `AsyncGenerator` 那样丢掉 `result()`，否则 loop 调用 `response.result()` 会抛 TypeError
 * 并导致 run 异常收尾。这里只把事件迭代包进 `guardStream` 做失败观测，原样透传 `result()`。
 *
 * 以宽松签名接收原始 streamFn（避免与具体模型/上下文类型耦合），调用方负责把返回值
 * 转型为 agentLoop 需要的 `StreamFn`。
 *
 * @param streamFn 原始 LLM 流式函数（来自模型 runtime）。
 * @param breaker 熔断器实例（实例级共享）。
 * @returns 包装后的 streamFn。
 */
export function guardStreamFn(
  streamFn: unknown,
  breaker: CircuitBreaker
): (...args: unknown[]) => Promise<AsyncIterable<{ type?: string }> & { result?: () => Promise<unknown> }> {
  return async (...args: unknown[]) => {
    // OPEN 且冷却内：快速失败，不再打已故障的 provider（run 以 failed 收尾）。
    // 注意：快速失败路径只抛出，绝不调用 recordFailure()——否则会把 openedAt 不断刷新到 now，
    // 导致 half-open 探针永远无法触发、provider 永久跳闸（原缺陷）。打开时的那次失败已在 guardStream 收尾时计入。
    if (!breaker.canAttempt()) {
      throw new Error("LLM provider circuit breaker is open; failing fast to protect SLO.");
    }
    const resolved = streamFn as (...a: unknown[]) => Promise<AsyncIterable<{ type?: string }> & { result?: () => Promise<unknown> }>;
    const response = await resolved(...args);
    // 透传原始 EventStream：仅用 guardStream 包裹事件迭代做失败观测，
    // 同时保留 response.result()（agentLoop 取最终消息的契约方法），避免 loop 悬挂。
    const guarded: AsyncIterable<{ type?: string }> & { result?: () => Promise<unknown> } = {
      [Symbol.asyncIterator]() {
        return guardStream(response, breaker);
      }
    };
    if (typeof (response as { result?: unknown }).result === "function") {
      guarded.result = () => (response as { result: () => Promise<unknown> }).result();
    }
    return guarded;
  };
}

/**
 * 包装事件流：透传事件，仅做失败观测——以 error 事件收尾或抛异常记为失败，正常完成记为成功。
 *
 * @param stream 原始 LLM 事件流。
 * @param breaker 熔断器实例。
 * @returns 透传的事件流。
 */
async function* guardStream(
  stream: AsyncIterable<{ type?: string }>,
  breaker: CircuitBreaker
): AsyncGenerator<{ type?: string }> {
  // 终态事件即收口：done=成功、error=失败。
  // 关键契约：agentLoop 在收到 done/error 后会立即 return 退出 for await，导致本生成器未被消费完、
  // 循环后的收尾逻辑不会执行。因此必须在「事件穿过时」即时记录，否则成功路径永远不会调用 recordSuccess，
  // 失败计数永不复位，熔断器一旦 OPEN 就再也无法回到 closed（P2 恢复链路失效）。
  try {
    for await (const event of stream) {
      if (event.type === "error") breaker.recordFailure();
      else if (event.type === "done") breaker.recordSuccess();
      yield event;
    }
  } catch (caught) {
    // 迭代期异常（如 provider 中途崩溃、连接被重置）也算一次失败（防御性兜底）。
    breaker.recordFailure();
    throw caught;
  }
}
