/**
 * replay + live 事件流合并。
 *
 * 语义（spec §5.4）：
 * 1. 先登记 live listener，新事件进入缓冲 `Map<sequence, event>`；
 * 2. 再读 `sequence > afterSequence` 的已落盘事件；
 * 3. 两路按 sequence 合并去重、严格递增投递；
 * 4. replay 完成后继续投递 live 缓冲；
 * 5. 终态到达或退订/关闭时释放资源。
 * sequence 可跳号（瞬态 `message_update` 不落盘），但不得倒退或重复。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";

/** replay 输入。 */
export interface ReplayMergeOptions {
  afterSequence?: number;
  /** 仅实时、不回放历史（serve 进程内句柄镜像在途 run 使用）。 */
  liveOnly?: boolean;
  readEvents: () => Promise<RunStreamEventDtoV2[]>;
  attachLive: (listener: (event: RunStreamEventDtoV2) => void) => () => void;
  onEvent: (event: RunStreamEventDtoV2) => void;
}

/**
 * 判断事件是否为 run 终态信号。
 *
 * `agent_end` 不是流结束：run 仍可能随后追发 `cost_summary` / `run_status`。
 *
 * @param event 事件。
 * @returns 终态事件返回 true。
 */
function isTerminalEvent(event: RunStreamEventDtoV2): boolean {
  if (event.type === "run_error") return true;
  if (event.type !== "run_status") return false;
  const status = (event.payload as { status?: unknown } | undefined)?.status;
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/**
 * 启动 replay+live 合并订阅。
 *
 * @param options afterSequence、读盘函数、live 挂载函数与事件回调。
 * @returns 退订函数（幂等）。
 */
export function subscribeWithReplay(options: ReplayMergeOptions): () => void {
  const afterSequence = options.afterSequence ?? 0;
  const liveBuffer = new Map<number, RunStreamEventDtoV2>();
  const sent = new Set<number>();
  let replayDone = false;
  let closed = false;
  let detachLive: (() => void) | undefined;

  /**
   * 按 sequence 升序、严格递增地投递缓冲事件；重复 sequence 直接丢弃。
   */
  const flushBuffer = () => {
    const ordered = [...liveBuffer.entries()].sort((left, right) => left[0] - right[0]);
    for (const [sequence, event] of ordered) {
      if (sent.has(sequence)) {
        liveBuffer.delete(sequence);
        continue;
      }
      sent.add(sequence);
      liveBuffer.delete(sequence);
      try {
        options.onEvent(event);
      } catch {
        // 单订阅者失败不影响其它订阅者与 run 执行。
      }
    }
  };

  /**
   * live 通道回调：先入缓冲，replay 完成后再统一按序投递，避免与 replay 竞态乱序。
   */
  const onLiveEvent = (event: RunStreamEventDtoV2) => {
    if (closed || event.sequence <= afterSequence || sent.has(event.sequence)) return;
    const isTerminal = isTerminalEvent(event);
    liveBuffer.set(event.sequence, event);
    if (replayDone) flushBuffer();
    if (isTerminal) {
      closed = true;
      if (replayDone) flushBuffer();
      liveBuffer.clear();
      detachLive?.();
    }
  };

  detachLive = options.attachLive(onLiveEvent);

  // liveOnly：跳过历史回放，仅挂 live 通道（句柄镜像在途 run，等价于旧 live-only 订阅）。
  if (options.liveOnly) {
    replayDone = true;
    return () => {
      closed = true;
      detachLive?.();
    };
  }

  void options
    .readEvents()
    .then((persisted) => {
      if (closed) return;
      for (const event of persisted) {
        if (event.sequence <= afterSequence || sent.has(event.sequence)) continue;
        sent.add(event.sequence);
        try {
          options.onEvent(event);
        } catch {
          // 单订阅者失败不影响其它订阅者与 run 执行。
        }
      }
      replayDone = true;
      flushBuffer();
      // 终态可能在读盘前到达：缓冲里若已有终态帧，此刻统一完成关闭。
      if ([...liveBuffer.values()].some(isTerminalEvent) || persisted.some(isTerminalEvent)) {
        closed = true;
        liveBuffer.clear();
        detachLive?.();
      }
    })
    .catch(() => {
      // 读盘失败时保持 live 订阅；replay 阶段跳过，后续事件仍可经 live 通道到达。
      replayDone = true;
      flushBuffer();
    });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    closed = true;
    liveBuffer.clear();
    sent.clear();
    detachLive?.();
  };
}
