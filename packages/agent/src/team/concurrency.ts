/**
 * 最小并发原语（P0）：把「同进程多代理顺序执行」升级为可控 worker 池。
 *
 * 对齐 pi subagent 的 `mapWithConcurrencyLimit`：N 个 worker 从自增 `nextIndex` 取任务、
 * 并发 await，从而把「同时在飞」的任务数限制在 limit 内。无额外依赖、无全局状态，
 * 仅用一个计数器 + Promise.all 即可，适合学习原型的可追溯并发。
 */

/**
 * 极简信号量：把同时在飞的任务数限制在 `capacity` 内。
 * `acquire` 在有余量时立即放行，否则等待最早释放者；`release` 唤醒一个等待者。
 * 不引入额外依赖，仅用 Promise 链实现。
 */
export class Semaphore {
  /** 容量（最大并发数）。 */
  private readonly capacity: number;
  /** 当前已占用许可数。 */
  private active = 0;
  /** 等待许可的 resolve 队列（FIFO）。 */
  private readonly waiters: Array<() => void> = [];

  /**
   * 构造信号量。
   * @param capacity 最大并发许可数（必须 >=1）。
   */
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /** 获取一个许可；若已满则等待，直到有许可释放。 */
  acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 释放一个许可，唤醒最早等待者（若有）。 */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 直接把许可交给等待者，active 计数不增减（占用权转移）。
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}

/**
 * 异步互斥锁（P0 修复 A-1 用）：把「读共享状态 → 判定 → 提交写入」收敛为一次原子操作。
 *
 * 背景：成本护栏的团队总 ceiling 依赖一个跨成员共享的累加器；并发成员的钩子若在
 * await 间隙穿插，会出现「两个成员都读到同一 totalCost 都判定未超 ceiling」而双双放行
 * 突破团队上限。`AsyncMutex` 用单条 Promise 链把临界区串行化——`acquire` 在锁空闲时
 * 立即放行，否则把 resolve 入队；`release` 唤醒队首等待者（占用权转移，计数器不变）。
 * 注意：只锁「读-判-写」这段临界区，绝不锁整次 LLM 调用，否则并发退化成串行。
 */
export class AsyncMutex {
  /** 是否已上锁。 */
  private locked = false;
  /** 等待锁的 resolve 队列（FIFO）。 */
  private readonly waiters: Array<() => void> = [];

  /**
   * 获取锁；若已被占用则等待，直到持有者 release。
   * @returns 一个在拿到锁时 resolve 的 Promise（resolve 后调用方进入临界区）。
   */
  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * 释放锁：唤醒最早等待者（若有）把占用权转移给它；否则置为未锁。
   * 必须在临界区末尾调用（建议包在 try/finally 里），否则等待者会永远挂起。
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 直接把锁交给等待者，locked 保持 true（占用权转移，无需增减计数）。
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * pi 风格 worker 池：用 limit 个 worker 从自增 `nextIndex` 取任务并发 await，
 * 限制同时在飞任务数。返回与输入顺序一致的结果数组（不因并发乱序）。
 *
 * @param items 待处理任务列表。
 * @param limit 最大并发数（在飞上限）。
 * @param fn 处理单个 item 的异步函数（index 为原始下标）。
 * @returns 与 items 顺序一致的结果数组。
 * @template T 输入项类型。
 * @template R 单个处理结果类型。
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    // 每个 worker 循环取下一个任务，直到所有任务被取完。
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
