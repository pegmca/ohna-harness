/**
 * run 采集层共享原语（docs/v1.4/06 A3-B 退役镜像通道后保留的部分）。
 *
 * 单一形态下执行权已交给 serve（agentLoop + RunManager 在 serve 内运行并自行发射
 * `llm_call` 事件），CLI 不再把 loop 事件镜像给 serve 或写本地 JSONL。本模块只保留
 * 「共享 callIndex 计数器 + 已采集标记 streamFn」这组被 Team 子代理复用的采集原语，
 * 它们已下沉为无副作用的纯构造器，不持有任何 sink。
 */
import type { AgentEvent, StreamFn } from "@aiagent/agent";
import { createLlmTraceStreamFn, markTracedStreamFn } from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";
import type { LlmCallRecordDto } from "@aiagent/types";

/** 一次 LLM 采集记录（`llm_call`）——与 serve 的 `LlmCallPushEvent` 同构。 */
export interface LlmCallPushEvent {
  type: "llm_call";
  payload: LlmCallRecordDto;
}

/**
 * 观测句柄：仅作为类型保留，供需要「事件推送目标」的纯函数签名复用。
 * 单一形态下不再有 CLI 侧镜像实现。
 */
export interface ObservationHandle {
  push(event: AgentEvent | LlmCallPushEvent): void;
  end(result?: { failed?: boolean }): void;
}

/**
 * 当前 run 的观测句柄引用（可变）。
 *
 * 为什么需要共享引用：TeamController 在组合根创建（早于任何 run），但采集目标每轮都变；
 * 子代理的 streamFn 通过 `read()` 实时读取，避免为每次 run 重建 controller。
 */
export interface ObservationRef {
  current: ObservationHandle | undefined;
}

/**
 * 创建观测引用容器。
 *
 * @returns 初始为空的可变引用。
 */
export function createObservationRef(): ObservationRef {
  return { current: undefined };
}

/**
 * 由若干观测句柄共享的 callIndex 计数器（每个 run 归零一次）。
 *
 * 为什么必须共享：主线程由 runTurn 调用、子代理由 TeamController 调用，两条链共用
 * 同一次 run 的 trace；各自计数会出现「两条 callIndex:1」（S1）。
 */
export interface TraceCounter {
  value: number;
}

/**
 * 创建按当前观测句柄采集的 streamFn（供 TeamController 与 runTurn 共用）。
 *
 * 同一个句柄复用同一个 wrapper，`callIndex` 通过共享 `counter` 在一次 run 内跨
 * supervisor / 子代理连续递增；无观测时直接透传 `base`，零额外开销。
 *
 * 返回值带「已采集」标记：runTurn 看到标记就不再包第二层（双重包装会让 callIndex 重复）。
 *
 * @param read 读取当前 run 的观测句柄。
 * @param counter 共享的 callIndex 计数器。
 * @param base 底层 StreamFn（缺省 `streamSimple`；测试注入 stub）。
 * @returns 可直接交给 agentLoop / TeamController 的 StreamFn。
 */
export function createTracedStreamFn(
  read: () => ObservationHandle | undefined,
  counter: TraceCounter,
  base: StreamFn = streamSimple as StreamFn,
): StreamFn {
  let cached: { handle: ObservationHandle; fn: StreamFn } | undefined;

  const forwarding: StreamFn = (model, context, options) => {
    const handle = read();
    if (!handle) return base(model, context, options);
    if (cached?.handle !== handle) {
      cached = {
        handle,
        fn: createLlmTraceStreamFn(
          base,
          (record) => handle.push({ type: "llm_call", payload: record }),
          counter,
        ),
      };
    }
    return cached.fn(model, context, options);
  };

  return markTracedStreamFn(forwarding);
}
