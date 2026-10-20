/**
 * run 观测接线（docs/v1.4/02-web-llm-trace.md 的 W3）。
 *
 * 三条约束决定了本模块的形状：
 * 1. **执行权不动**（D1）：默认模式仍是本地 agentLoop，观测只是把事件抄一份给 serve；
 * 2. **两种 sink 共用同一采集层**（D10）：观测台可用时推给 `observeRun`，不可用时写本地
 *    JSONL；`createLlmTraceStreamFn` 完全不需要知道区别；
 * 3. **Team 子代理也要被采集**（W3-6）：子代理的 streamFn 由组合根注入，读的是同一个
 *    「当前 run 观测句柄」引用，因此 supervisor 与子代理的记录落在同一条 run 里。
 */
import type { AgentEvent, StreamFn } from "@aiagent/agent";
import { createLlmTraceStreamFn, markTracedStreamFn } from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";
import type { LlmCallRecordDto } from "@aiagent/types";
import type { OhnaServer } from "@aiagent/serve";
import { createLlmTraceFileSink, defaultTraceDir } from "./llm-trace-file.js";

/** 一次 LLM 采集记录（`llm_call`）——与 serve 的 `LlmCallPushEvent` 同构。 */
export interface LlmCallPushEvent {
  type: "llm_call";
  payload: LlmCallRecordDto;
}

/**
 * 观测句柄：runTurn 把 loop 事件与 llm_call 记录推给它。
 *
 * 结构上与 `@aiagent/serve` 的 `ObservedRun` 一致（后者可直接当句柄用），
 * 这样 CLI 不必把「推到哪里」写进运行期代码。
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

/**
 * 一次 run 的观测启动器（组合根注入 REPL）。
 *
 * `start` 必须在 runTurn 之前调用：它负责为本次 run 选定 sink 并绑定到 `ObservationRef`。
 */
export interface TurnObserver {
  /**
   * @param userText 本轮用户输入（用于会话标题派生，可选）。
   * @param meta 会话 id 与本轮序号（写进 requestId，观测台据此区分会话）。
   * @returns 本轮观测句柄。
   */
  start(userText: string, meta: { sessionId: string; runIndex: number }): ObservationHandle;
}

/** 观测台观测器参数。 */
export interface ServerTurnObserverOptions {
  server: OhnaServer;
  conversationId: string;
  ref: ObservationRef;
  /**
   * 共享 callIndex 计数器；每轮 run 开始时归零（S1）。
   * 必填：漏传会让 callIndex 与 Team 链路分叉。运行期仍做防御性兜底（JS 调用方可能漏传）。
   */
  counter?: TraceCounter;
}

/**
 * 创建推送给进程内 serve 的观测器（默认模式）。
 *
 * `observeRun` 是异步的（要先落 run_meta），而 `start` 必须同步返回句柄：
 * 因此句柄内部先缓冲事件，等 run 落盘后再按序 flush。观测失败只静默丢弃。
 *
 * @param options server / 会话 / 共享引用。
 * @returns 观测器。
 */
export function createServerTurnObserver(options: ServerTurnObserverOptions): TurnObserver {
  /** 失败告警只打一次，避免每轮 run 刷屏。 */
  let warned = false;

  return {
    start(_userText, meta) {
      // 新一轮 run：callIndex 从 1 重新开始（共享 counter 由主线程与子代理共用）。
      // JS 调用方可能漏传 counter：兜底成独立计数器，绝不在 start() 抛 TypeError 带崩本轮 run。
      const counter = options.counter ?? { value: 0 };
      counter.value = 0;
      const buffered: (AgentEvent | LlmCallPushEvent)[] = [];
      let resolved: ObservationHandle | undefined;
      let ended = false;
      let failed = false;
      let endResult: Parameters<ObservationHandle["end"]>[0];

      /**
       * 观测镜像失败：丢弃缓冲、解绑引用；坏 conversationId / 磁盘异常都不能带崩 CLI（N6）。
       *
       * @param error 失败原因（仅用于一次性告警）。
       */
      const fail = (error: unknown): void => {
        failed = true;
        buffered.length = 0;
        if (options.ref.current === handle) options.ref.current = undefined;
        if (warned) return;
        warned = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`⚠️ 观测台镜像已降级（本轮 trace 不完整）：${message}\n`);
      };

      const handle: ObservationHandle = {
        push(event) {
          if (failed) return;
          if (resolved) resolved.push(event);
          else buffered.push(event);
        },
        end(result) {
          ended = true;
          endResult = result;
          if (resolved) resolved.end(result);
          if (options.ref.current === handle) options.ref.current = undefined;
        },
      };
      // 先绑定引用：第一个 LLM 调用的采集记录要落进本句柄的缓冲区。
      options.ref.current = handle;

      try {
        void options.server
          .observeRun({
            conversationId: options.conversationId,
            // requestId 内嵌 sessionId + turnIndex：同一 conversation 下多个 CLI 会话可区分。
            requestId: `${meta.sessionId}:${meta.runIndex}`,
          })
          .then((observed) => {
            if (failed) return;
            resolved = observed;
            for (const event of buffered) observed.push(event);
            buffered.length = 0;
            if (ended) observed.end(endResult);
          })
          .catch(fail);
      } catch (error) {
        // observeRun 也可能同步抛错（如参数校验），同样按观测降级处理。
        fail(error);
      }

      return handle;
    },
  };
}

/** 文件观测器参数。 */
export interface FileTurnObserverOptions {
  ref: ObservationRef;
  /**
   * 共享 callIndex 计数器；每轮 run 开始时归零（S1）。
   * 必填：漏传会让 callIndex 与观测台链路分叉。运行期仍做防御性兜底（JS 调用方可能漏传）。
   */
  counter?: TraceCounter;
  /** 目录覆盖（测试注入；缺省 `~/.ohna/traces`）。 */
  baseDir?: string;
}

/**
 * 创建本地 JSONL 观测器（`--no-web` 或观测台启动失败时的降级链）。
 *
 * 只记录 LLM 采集事项：loop 事件已由 CLI 自己的会话存储/渲染负责，无需再抄一份。
 *
 * @param options 共享引用与目录覆盖。
 * @returns 观测器。
 */
export function createFileTurnObserver(options: FileTurnObserverOptions): TurnObserver {
  return {
    start(_userText, meta) {
      // 降级链同样按 run 归零：--no-web 的记录 callIndex 语义与观测台一致。
      // 同样对漏传 counter 的 JS 调用方兜底，避免 start() 抛错。
      const counter = options.counter ?? { value: 0 };
      counter.value = 0;
      const sink = createLlmTraceFileSink(meta.sessionId, options.baseDir ?? defaultTraceDir());
      const handle: ObservationHandle = {
        push(event) {
          if (event.type === "llm_call") sink(event.payload);
        },
        end() {
          if (options.ref.current === handle) options.ref.current = undefined;
        },
      };
      options.ref.current = handle;
      return handle;
    },
  };
}
