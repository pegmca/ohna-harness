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
 *
 * v2.0 扩展（docs/v2.0/04 §1.1 / §1.2 / §1.4）：
 * - 每次调用额外记录 `window`（必填，构造 wrapper 时注入）与 `agentId`（读 options.observer）；
 * - `composition`（五分类 token 构成）在 onPayload 拿到**最终** context 后现算，
 *   不缓存、不跨调用复用——同一 wrapper 的多次调用各自计算。
 */
import { randomUUID } from "node:crypto";
import { AssistantMessageEventStream } from "@aiagent/ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@aiagent/ai";
import type {
  LlmCallRecordDto,
  LlmCallRequestDto,
  LlmCallResponseDto,
  LlmCallUsageDto,
  LlmCompositionDto,
  LlmWindowDto,
} from "@aiagent/types";
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
 * 估算系数：每 token 折算的字符数（ASCII 主导假设）。
 *
 * 偏差方向：CJK 字符每字约占 1 个 token 甚至更多（远高于 ASCII 的 ~1/4），因此
 * `chars ÷ 4` 对中文内容会**低估** token 数（即真实 token 比估算值更多）。这是刻意的
 * 固定口径——不做语言感知，三面板图例统一按「低估」表述（docs/v2.0/04 §1.4）。
 */
const CHARS_PER_TOKEN = 4;

/**
 * 估算一次 LLM 请求的窗口构成：五分类 token 数（docs/v2.0/04 §1.4 的固定系数表）。
 *
 * 口径（全部是**估算**，与 provider 回报的 usage 是两套账，展示时并列不对齐）：
 * - `system`：`systemPrompt` 字符串长度 ÷ 4；
 * - `tools`：每个工具 `JSON.stringify({ name, description, inputSchema })` 长度 ÷ 4 求和；
 * - `user` / `assistant` / `toolResult`：按消息 role 归三类，逐条 content blocks 求和后 ÷ 4：
 *   - 文本块：chars ÷ 4（thinking 块按同一文本口径计入 assistant）；
 *   - toolCall 块：`JSON.stringify(block)` 长度 ÷ 4（含名字、参数与 id）；
 *   - 其余块（image 等）：其 JSON 序列化长度 ÷ 4；
 *   - `content` 为纯字符串时按一个文本块处理（user 消息可为字符串形态）。
 * - `total`：上述五项之和。
 *
 * 为什么在采集层算而不是 web 现算：onPayload 已拿到 convertToLlm 之后的最终形态，
 * 三部分齐全；在此算一次即成为单一事实源，web 不重复推导、不依赖任何估算器。
 *
 * @param systemPrompt 系统提示词（可为 undefined，按 0 计）。
 * @param messages convertToLlm 之后的最终 LLM 消息序列（结构来源：`@aiagent/ai` 的 `Message`）。
 * @param tools 本次请求携带的工具列表（name / description / parameters）。
 * @returns 五分类构成与合计；非有限值一律按 0 计，绝不抛错。
 */
export function estimateComposition(
  systemPrompt: string | undefined,
  messages: readonly Message[],
  tools: readonly Pick<ModelTool, "name" | "description" | "parameters">[] | undefined,
): LlmCompositionDto {
  const system = charsToTokens(systemPrompt?.length ?? 0);

  let toolsChars = 0;
  for (const tool of tools ?? []) {
    toolsChars += jsonLength({ name: tool.name, description: tool.description, inputSchema: tool.parameters });
  }

  let userChars = 0;
  let assistantChars = 0;
  let toolResultChars = 0;
  for (const message of messages) {
    const chars = messageContentChars(message);
    if (message.role === "user") userChars += chars;
    else if (message.role === "assistant") assistantChars += chars;
    else toolResultChars += chars;
  }

  const user = charsToTokens(userChars);
  const assistant = charsToTokens(assistantChars);
  const toolResult = charsToTokens(toolResultChars);
  const toolsTokens = charsToTokens(toolsChars);
  return {
    system,
    tools: toolsTokens,
    user,
    assistant,
    toolResult,
    total: system + toolsTokens + user + assistant + toolResult,
  };
}

/** 最小工具形状：只取 @aiagent/ai `Tool` 里参与估算的三个字段（避免不必要的类型耦合）。 */
type ModelTool = { name: string; description: string; parameters: unknown };

/**
 * 字符数 → token 估算值（向上取整，保证非零内容不因舍入消失）。
 *
 * @param chars 字符数。
 * @returns 估算 token 数。
 */
function charsToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 单条消息的字符数（按 content blocks 分块口径，见 `estimateComposition`）。
 *
 * @param message 一条 LLM 消息。
 * @returns 该消息参与估算的字符总数。
 */
function messageContentChars(message: Message): number {
  const content: unknown = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      chars += block.thinking.length;
      continue;
    }
    // toolCall 与 image 等其余块：按 JSON 序列化长度计量（含 name / arguments / id / mimeType）。
    chars += jsonLength(block);
  }
  return chars;
}

/**
 * JSON 序列化长度；不可序列化（循环引用等）时退回 String 化，绝不让估算抛错。
 *
 * @param value 待计量值。
 * @returns 字符长度。
 */
function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
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
 * @param options 采集选项；`window` **必填**（构造 wrapper 时注入模型窗口与压缩预留）。
 *                这里刻意不提供缺省值/向后兼容：`LlmCallRecordDto.window` 是必填字段，
 *                让缺省悄悄造一个假窗口，比编译期报错危险得多（docs/v2.0/04 §1.1）。
 * @returns 具备相同签名、附带采集能力的 StreamFn。
 */
export function createLlmTraceStreamFn(
  base: StreamFn,
  sink: LlmTraceSink,
  counter: { value: number } | undefined,
  options: { window: LlmWindowDto }
): StreamFn {
  /** run 内 LLM 调用序号（从 1 起）。只统计本 wrapper 实例发起的调用（未传 counter 时）。 */
  let localCallIndex = 0;
  // 闭包捕获构造参数：内层同名 `options` 是**单次调用**的流式选项，两者不可混用。
  const window = options.window;

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
    /**
     * onPayload 现算的窗口构成。
     *
     * 只有「最终 context 被适配器观察过」时才存在；错误早退（同步 throw / 未到 onPayload）
     * 时保持 undefined——这是对运行时事实的忠实建模，消费侧据此不渲染构成占比。
     */
    let composition: LlmCompositionDto | undefined;

    const request: LlmCallRequestDto = snapshotRequest(model, context, options);

    /**
     * 调用方注入的 agent 身份（`options.observer`，docs/v2.0/04 §1.2）。
     *
     * 为什么在调用入口取一次而不是在 onPayload 里取：身份是**发起方**的属性，
     * 与 provider 是否接受本次请求无关——同步 throw 的错误记录同样需要归因到发起的 agent
     * （否则 Trace 森林里会出现一批无主的失败调用）。可空仅表示调用方未注入。
     */
    const agentId = options?.observer?.agentId;

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
        // window 与请求成败无关：构造 wrapper 时即注入，任何错误早退路径都带着它落盘。
        window,
      };
      if (tail.response) record.response = tail.response;
      if (tail.error) record.error = tail.error;
      // 可空两字段只写「确实有值」的项，避免落盘出现 undefined 噪声。
      // agentId 来自调用方注入的 options.observer，与请求是否发出无关（同步 throw 路径同样有值）；
      // composition 依赖适配器回灌最终 context，错误早退时缺省。
      if (agentId !== undefined) record.agentId = agentId;
      if (composition !== undefined) record.composition = composition;

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
        // 窗口构成在此现算：此刻 systemPrompt / messages / tools 已是最终形态（convertToLlm 之后）。
        // 重试会重复进入本钩子，直接用最新一次覆盖即可（终态上报只读最后一次的值）。
        composition = estimateComposition(context.systemPrompt, context.messages, context.tools);
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
