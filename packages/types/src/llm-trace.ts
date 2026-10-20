/**
 * LLM 请求/响应全程追踪的线格式 DTO（docs/v1.4/02-web-llm-trace.md）。
 *
 * 归属：跨边界 DTO——CLI 镜像、serve SSE / JSONL 落盘、ohna-web 反序列化三方共用。
 * 因此放在 `@aiagent/types`（只收线格式 / 持久化形状），而非 @aiagent/ai / @aiagent/agent
 * 的领域类型。`message` / `providerPayload` / `messages` 用 `unknown` + JSDoc 标明结构来源，
 * 保持 types 叶子纯净，不反向依赖模型/循环层。
 */

/**
 * 一次 LLM 请求/响应的完整线格式记录。
 * 采集层（`@aiagent/agent` 的 `createLlmTraceStreamFn`）在一次 stream 调用内产出，
 * 经 run 事件的 `llm_call` kind 进入 SSE / JSONL / web 观测台。
 */
export interface LlmCallRecordDto {
  /** 记录唯一标识（randomUUID）。 */
  callId: string;
  /** run 内第几次 LLM 调用，从 1 起。 */
  callIndex: number;
  /** 发起时刻（epoch 毫秒）。 */
  startedAt: number;
  /** 端到端耗时（毫秒）；done/error 到达且可汇聚时存在。 */
  durationMs?: number;
  /**
   * adapter 显式构造/重放 payload 的次数；openai-completions 的 HTTP 重试在
   * retryProviderRequest 内不重建 payload，生产恒为 1；逐次 attempt 见计划 §8（开放项）。
   */
  attemptCount: number;
  /** 统一请求参数（见 LlmCallRequestDto）。 */
  request: LlmCallRequestDto;
  /** 响应摘要（done/error 到达且可汇聚时存在）。 */
  response?: LlmCallResponseDto;
  /** 失败/中断信息（abort、无终态事件或上游 throw 时存在）。 */
  error?: { message: string; stopReason?: string };
}

/** 统一请求参数：模型目录 + transformContext→convertToLlm 后的最终消息 + 工具 + 采样参数。 */
export interface LlmCallRequestDto {
  /** provider 标识。 */
  provider: string;
  /** 线协议标识（openai-completions / anthropic-messages / google-generative-ai）。 */
  api: string;
  /** 请求模型 id。 */
  modelId: string;
  /** provider baseUrl。 */
  baseUrl: string;
  /** 系统提示词。 */
  systemPrompt?: string;
  /**
   * 统一 Message[]（transformContext → convertToLlm 之后的最终序列），structuredClone 快照。
   * 结构来源：@aiagent/ai 的 `Message` 联合类型。
   */
  messages: unknown;
  /** 工具列表（name / description / inputSchema），由 toLlmTools 序列化后的 JSON Schema。 */
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** 采样温度。 */
  temperature?: number;
  /** max tokens（经上下文窗口钳制后的值）。 */
  maxTokens?: number;
  /** thinking 档位。 */
  reasoning?: string;
  /** 工具选择策略（透传给支持的协议 adapter）。 */
  toolChoice?: unknown;
  /** 调用方配置的 maxRetries（语义同 StreamOptions）。 */
  retries?: number;
  /**
   * 实际发给 provider 的请求体（onPayload 观察的最终 payload，含 provider 专有字段）。
   * 结构来源：@aiagent/ai 各 adapter 的 `buildParams` 产物。
   */
  providerPayload?: unknown;
}

/** 响应摘要：onResponse 观察的 HTTP 状态 + done/error 事件的最终 AssistantMessage。 */
export interface LlmCallResponseDto {
  /** HTTP 状态码（onResponse 观察；连接失败时不存在）。 */
  status?: number;
  /** 终态原因（= AssistantMessage.stopReason）。 */
  finishReason?: string;
  /** token 用量 + 成本（对齐 @aiagent/ai 的 Usage，含 cost.total）。 */
  usage?: LlmCallUsageDto;
  /** provider 侧响应标识（chunk.id）。 */
  responseId?: string;
  /** 上游实际返回的 chunk.model（与请求模型不同时，如路由网关）。 */
  responseModel?: string;
  /**
   * done/error 事件的最终 AssistantMessage（content blocks / toolCalls / errorMessage）。
   * 结构来源：@aiagent/ai 的 `AssistantMessage`。
   */
  message?: unknown;
}

/** token 用量与成本快照（对齐 @aiagent/ai 的 Usage 子集）。 */
export interface LlmCallUsageDto {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  };
}
