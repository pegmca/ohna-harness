/**
 * LLM 请求/响应采集层（docs/v1.4/02-web-llm-trace.md 的 W1）。
 *
 * 设计要点（D2 / D5 / D6 / D11）：
 * - **调用方包装**：本模块只提供一个 `StreamFn → StreamFn` 的高阶函数，宿主把它交给
 *   agentLoop / TeamController 即可；`agent-loop.ts` 零改动（观测不侵入内核）。
 * - **钩子组合**：`@aiagent/ai` 的协议 adapter 已在「构造请求体之后、发 POST 之前」调用
 *   `options.onPayload`，并在收到 HTTP 响应时调用 `options.onResponse`。wrapper 通过链式
 *   覆盖这两个钩子拿到**最终**provider 请求体与 HTTP 状态，不需要解析 SSE 帧。
 * - **响应靠事件聚合**：`done` / `error` 事件自带最终 `AssistantMessage`（content blocks、
 *   toolCalls、usage、stopReason），wrapper 只做透传 + 一次聚合，不缓冲流式增量。
 * - **不改失败语义**：上游 throw 先记账再原样 rethrow 同一个错误对象；sink 抛错被吞掉，
 *   观测链路故障不得打断 run。
 */
import { randomUUID } from "node:crypto";
import { AssistantMessageEventStream } from "@aiagent/ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@aiagent/ai";
import type { LlmCallRecordDto, LlmCallRequestDto, LlmCallResponseDto, LlmCallUsageDto } from "@aiagent/types";
import type { StreamFn } from "./types.js";

/** 采集结果的出口：serve 侧转成 `llm_call` run 事件（单一形态下 CLI 与 Web 共用此执行线）。 */
export type LlmTraceSink = (record: LlmCallRecordDto) => void;

/** 无终态事件时的兜底错误文案（abort / Ctrl-C 场景常见）。 */
const NO_TERMINAL_EVENT_MESSAGE = "stream ended without terminal event";

/**
 * 「已带采集」标记：Symbol.for 保证跨模块（agent / CLI）读到同一个键，且不写进枚举属性。
 */
const TRACED_STREAM_MARK = Symbol.for("aiagent.llm-trace.stream-fn");

/**
 * 给任意 StreamFn 打上「已带采集」标记，避免调用方再包一层（双重包装会让 callIndex 重复）。
 *
 * @template TStreamFn StreamFn 的具体类型。
 * @param streamFn 待标记的 StreamFn。
 * @returns 同一个函数对象（便于链式使用）。
 */
export function markTracedStreamFn<TStreamFn extends StreamFn>(streamFn: TStreamFn): TStreamFn {
  Object.defineProperty(streamFn, TRACED_STREAM_MARK, { value: true, enumerable: false });
  return streamFn;
}

/**
 * 判断一个 StreamFn 是否已经带采集（本包的 wrapper 或宿主自行标记的转发器）。
 *
 * @param streamFn 待检查的 StreamFn（可为 undefined）。
 * @returns 已带采集返回 true。
 */
export function isTracedStreamFn(streamFn: StreamFn | undefined): boolean {
  if (!streamFn) return false;
  return (streamFn as unknown as Record<symbol, unknown>)[TRACED_STREAM_MARK] === true;
}

/**
 * 把任意 StreamFn 包装成「每次调用产出一条 LlmCallRecordDto」的 StreamFn。
 *
 * 一次返回的函数被多次调用时（同一 run 内的多轮 LLM 调用），`callIndex` 由闭包计数器
 * 从 1 递增；`callId` 每次重新分配。返回的函数本身对单次调用无共享可变状态。
 *
 * **共享计数**：宿主若同时包装主线程与 Team 子代理，必须传入同一个 `counter`，
 * 否则两条链会各自从 1 开始、出现重复 callIndex（S1）。
 *
 * 语义约定（D4 / D11）：
 * - 事件逐个透传，顺序与内容不变，不打断流式增量；
 * - `done` / `error` 到达时聚合响应并上报，随后照常透传终态事件；
 * - 上游调用抛错 → 先上报 error 记录，再 `throw` **同一个**错误对象；
 * - 流正常结束但无终态事件 → 上报 `error: { message: "stream ended without terminal event" }`；
 * - sink 抛错被吞掉，绝不改变 run 的结果。
 *
 * @param base 被包装的底层 StreamFn（通常是 `streamSimple`）。
 * @param sink 记录出口；实现方需自行保证不阻塞（serve 侧入队、文件侧 append）。
 * @param counter 可选共享计数器（`{ value }`）；缺省时 wrapper 自持闭包计数。
 * @returns 具备相同签名、附带采集能力的 StreamFn。
 */
export function createLlmTraceStreamFn(
  base: StreamFn,
  sink: LlmTraceSink,
  counter?: { value: number }
): StreamFn {
  /** run 内 LLM 调用序号（从 1 起）。只统计本 wrapper 实例发起的调用（未传 counter 时）。 */
  let localCallIndex = 0;

  const streamFn: StreamFn = (model, context, options) => {
    const index = counter ? (counter.value += 1) : (localCallIndex += 1);
    const callId = randomUUID();
    const startedAt = Date.now();
    // durationMs 用单调时钟测算：Date.now() 只有毫秒分辨率，亚毫秒调用会算出 0，
    // 而 0 在消费侧与「缺失」不可区分。
    const startedHr = performance.now();

    /** onPayload 被观察到的次数（adapter 显式构造/重放 payload 的次数，详见 record.attemptCount 注释）。 */
    let payloadObservations = 0;
    /** onResponse 观察到的 HTTP 状态（连接失败时保持 undefined）。 */
    let responseStatus: number | undefined;
    /** 防重复上报：终态只上报一次（例如 done 之后误再推 error）。 */
    let reported = false;

    const request: LlmCallRequestDto = snapshotRequest(model, context, options);

    /**
     * 上报一条记录（幂等）；sink 异常一律吞掉，观测不得打断 run。
     *
     * @param tail 终态补充字段：response 与/或 error。
     */
    const report = (tail: { response?: LlmCallResponseDto; error?: LlmCallRecordDto["error"] }): void => {
      if (reported) return;
      reported = true;

      const record: LlmCallRecordDto = {
        callId,
        callIndex: index,
        startedAt,
        // 真实耗时，保留两位小数：亚毫秒调用不应被抬成 1ms（会污染「时延」判断）。
        durationMs: Math.round((performance.now() - startedHr) * 100) / 100,
        // adapter 显式构造/重放 payload 的次数；openai-completions 的 HTTP 重试在
        // retryProviderRequest 内不重建 payload，生产恒为 1；逐次 attempt 见计划 §8 开放项。
        attemptCount: payloadObservations > 0 ? payloadObservations : 1,
        request,
      };
      if (tail.response) record.response = tail.response;
      if (tail.error) record.error = tail.error;

      try {
        // sink 契约是同步的，但实现方可能返回 Promise（文件 append / 入队）：
        // 这里吞掉其 rejection，避免 unhandled rejection 打崩进程。
        const pending = sink(record) as unknown;
        if (pending instanceof Promise) void pending.catch(() => undefined);
      } catch {
        // 观测出口故障（磁盘满、SSE 断开）不得影响 run：记录丢失优于 run 失败。
      }
    };

    /** 把协议层的 Usage 收敛成线格式（cost 必填，reasoning 按需保留）。 */
    const toUsageDto = (usage: Usage): LlmCallUsageDto => {
      const dto: LlmCallUsageDto = {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: {
          input: usage.cost.input,
          output: usage.cost.output,
          cacheRead: usage.cost.cacheRead,
          cacheWrite: usage.cost.cacheWrite,
          total: usage.cost.total,
        },
      };
      if (usage.reasoning !== undefined) dto.reasoning = usage.reasoning;
      return dto;
    };

    /**
     * 由终态 AssistantMessage 聚合响应摘要。
     *
     * @param message done/error 事件携带的最终消息。
     * @returns 线格式响应；message 做深拷贝，避免消费侧后续引用突变污染记录。
     */
    const toResponseDto = (message: AssistantMessage): LlmCallResponseDto => {
      const dto: LlmCallResponseDto = {
        finishReason: message.stopReason,
        usage: toUsageDto(message.usage),
        message: snapshot(message),
      };
      if (responseStatus !== undefined) dto.status = responseStatus;
      if (message.responseId !== undefined) dto.responseId = message.responseId;
      if (message.responseModel !== undefined) dto.responseModel = message.responseModel;
      return dto;
    };

    // 链式注入钩子：先让调用方既有钩子生效（它可能替换 payload），再观察最终值。
    const chainedOptions: SimpleStreamOptions = {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const callerHook = options?.onPayload;
        let finalPayload = payload;
        if (callerHook) {
          const replaced = await callerHook(payload, payloadModel);
          if (replaced !== undefined) finalPayload = replaced;
        }
        payloadObservations += 1;
        // 请求体在 provider 侧可能被重试复用（retryProviderRequest），只能快照，
        // 否则记录会指向被后续重试改写的同一对象。
        request.providerPayload = snapshot(finalPayload);
        return finalPayload;
      },
      onResponse: async (providerResponse, responseModel) => {
        await options?.onResponse?.(providerResponse, responseModel);
        responseStatus = providerResponse.status;
      },
    };

    // 同步调用底层 StreamFn：若它直接 throw（契约违规但真实存在），保持同步抛出语义，
    // 调用方看到的错误对象与未包装时完全一致（D11）。
    let upstreamResult: ReturnType<StreamFn>;
    try {
      upstreamResult = base(model, context, chainedOptions);
    } catch (error) {
      const message = formatError(error);
      report({ error: { message } });
      throw error;
    }

    const outer = new AssistantMessageEventStream();

    /**
     * 异步泵：把底层流逐事件透传给 outer，并在终态做一次聚合。
     * 任何异常都先记账，再补一个 error 终态事件，保证消费方不会挂起。
     *
     * @returns 泵结束（外层流已 end 或已推入终态）时 resolve 的 Promise；不承载业务结果。
     */
    const pump = async (): Promise<void> => {
      let upstream: AssistantMessageEventStream;
      try {
        upstream = await upstreamResult;
      } catch (error) {
        // StreamFn 契约要求把失败编码进事件流；返回 rejected Promise 属违规实现，
        // 这里补一个 error 终态兜底（不再 rethrow，否则会成为无人接管的 rejection）。
        const message = formatError(error);
        report({ error: { message } });
        outer.push({ type: "error", reason: "error", error: synthesizeErrorMessage(model, message) });
        outer.end();
        return;
      }

      let sawTerminal = false;
      try {
        for await (const event of upstream) {
          if (event.type === "done" || event.type === "error") {
            // 终态事件先上报、再透传：sink 同步分配 run 事件 sequence，这样 llm_call
            // 一定排在 message_end / agent_end 之前，web 时间线的因果关系稳定。
            sawTerminal = true;
            if (event.type === "done") {
              report({ response: toResponseDto(event.message) });
            } else {
              report({
                response: toResponseDto(event.error),
                error: {
                  message: event.error.errorMessage ?? `LLM call failed with stopReason ${event.error.stopReason}`,
                  stopReason: event.error.stopReason,
                },
              });
            }
          }
          outer.push(event);
        }
      } catch (error) {
        // 迭代中途抛出（底层 adapter 违反「不抛出」契约）。此时流已返回给消费方，
        // 无法按 D11 原样 rethrow（会变成无人接管的 rejection），因此按 D11 的例外
        // 改写为 error 终态事件：记账 + 补终态，避免消费方悬挂。
        const message = formatError(error);
        report({ error: { message } });
        outer.push({ type: "error", reason: "error", error: synthesizeErrorMessage(model, message) });
        outer.end();
        return;
      }

      if (!sawTerminal) {
        // 无终态事件即结束（Ctrl-C / abort）：只记录，不给 outer 造终态事件——
        // 观测不能改变「流提前结束」这一既有语义。
        const stopReason = options?.signal?.aborted ? "aborted" : undefined;
        report({
          error: stopReason ? { message: NO_TERMINAL_EVENT_MESSAGE, stopReason } : { message: NO_TERMINAL_EVENT_MESSAGE },
        });
      }

      outer.end();
    };

    void pump();

    return outer;
  };

  // 打标记：宿主（CLI 的 Team 转发器 / 单轮 runTurn）据此判断「已采集」，避免二次包装。
  return markTracedStreamFn(streamFn);
}

/**
 * 构建统一请求参数快照。
 *
 * 只写「有值」的字段：`undefined` 键会让 JSONL/SSE 里出现 `"temperature": undefined`
 * 之类的噪声，也让 web 端无法区分「未设置」与「显式传 undefined」。
 *
 * @param model 本次调用的模型目录条目。
 * @param context convertToLlm 之后的最终 LLM 上下文。
 * @param options 调用方流式选项（仅取采样/工具选择相关字段）。
 * @returns 请求参数 DTO（providerPayload 由 onPayload 稍后回填）。
 */
function snapshotRequest(model: Model<Api>, context: Context, options?: SimpleStreamOptions): LlmCallRequestDto {
  const request: LlmCallRequestDto = {
    provider: model.provider,
    api: model.api,
    modelId: model.id,
    // baseUrl 可能内嵌凭据（如 https://user:token@host/v1），落盘前必须剥掉 userinfo。
    baseUrl: sanitizeBaseUrl(model.baseUrl),
    messages: snapshot(context.messages),
  };
  if (context.systemPrompt !== undefined) request.systemPrompt = context.systemPrompt;
  if (context.tools) {
    request.tools = context.tools.map((tool) => {
      const entry: { name: string; description?: string; inputSchema?: unknown } = { name: tool.name };
      if (tool.description !== undefined) entry.description = tool.description;
      if (tool.parameters !== undefined) entry.inputSchema = snapshot(tool.parameters);
      return entry;
    });
  }
  if (options?.temperature !== undefined) request.temperature = options.temperature;
  if (options?.maxTokens !== undefined) request.maxTokens = options.maxTokens;
  if (options?.reasoning !== undefined) request.reasoning = options.reasoning;
  if (options?.toolChoice !== undefined) request.toolChoice = options.toolChoice;
  if (options?.maxRetries !== undefined) request.retries = options.maxRetries;
  return request;
}

/**
 * 脱敏 baseUrl：移除 userinfo 与 query/hash，只保留 origin + path。
 *
 * 为什么需要：部分 provider 配置把 token 写进 URL（`https://user:token@gateway/v1`），
 * 这类凭据不属于「请求参数」，落盘即泄漏（D5）。解析失败时退化成正则剥离，绝不抛错——
 * 观测层不能因为一个畸形 URL 打断 run。
 *
 * @param baseUrl 模型目录里的原始 baseUrl。
 * @returns 可安全落盘的 baseUrl（保持 origin + path 语义）。
 */
function sanitizeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.origin + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    // 非标准 URL（如 http://localhost:8080 以外的手写形式）：去掉 //user:pass@ 与 ?/# 后缀。
    return baseUrl.replace(/\/\/[^/@]*@/, "//").split(/[?#]/)[0];
  }
}

/**
 * 深拷贝快照：优先 `structuredClone`（保留 undefined/循环结构）；
 * 非 JSON 值（函数、AbortSignal、类实例等）降级为 JSON 投影，仍不可序列化时退回原引用，
 * 绝不让观测层抛错。
 *
 * @template TValue 待快照的值类型。
 * @param value 原始值。
 * @returns 深拷贝 / JSON 投影；完全不可克隆时返回原值。
 */
function snapshot<TValue>(value: TValue): TValue {
  try {
    return structuredClone(value);
  } catch {
    // 非 JSON 值降级为 JSON 投影：至少保证记录不会因一个 AbortSignal 字段整条丢失。
    try {
      return JSON.parse(JSON.stringify(value)) as TValue;
    } catch {
      return value;
    }
  }
}

/**
 * 生成兜底 error 终态的 AssistantMessage（仅用于契约违规场景，正常路径不会触发）。
 *
 * @param model 本次调用的模型。
 * @param message 错误文案。
 * @returns stopReason 为 "error" 的最小可用消息。
 */
function synthesizeErrorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/**
 * 把任意抛出物格式化成可读错误文案。
 *
 * @param error 捕获到的错误值。
 * @returns 错误文案；非 Error 值走 String 化。
 */
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
