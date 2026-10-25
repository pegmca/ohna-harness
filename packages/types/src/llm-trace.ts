/**
 * LLM 请求/响应全程追踪的线格式 DTO（docs/v1.4/02-web-llm-trace.md）。
 *
 * 归属：跨边界 DTO——CLI 镜像、serve SSE / JSONL 落盘、ohna-web 反序列化三方共用。
 * 因此放在 `@aiagent/types`（只收线格式 / 持久化形状），而非 @aiagent/ai / @aiagent/agent
 * 的领域类型。`message` / `providerPayload` / `messages` 用 `unknown` + JSDoc 标明结构来源，
 * 保持 types 叶子纯净，不反向依赖模型/循环层。
 */

/**
 * 单次 LLM 请求的窗口构成快照：五分类 token 数（估算口径，见 docs/v2.0/04 §1.4）。
 *
 * 为什么在采集层算：`createLlmTraceStreamFn` 在 onPayload 已拿到 convertToLlm 之后的最终
 * context（systemPrompt / messages / tools 三者齐全），在此一次性算好；web 只做展示，
 * 不重复推导、也不依赖任何估算器（单一事实源）。
 *
 * 分类学说明：采集发生在最终 LLM 消息形态，注入内容（记忆/检索/skill）与普通 user 消息
 * 在此层级不可区分，因此统一并入 `user`；独立归因需前置到 context-assembly 层打
 * provenance 元数据（docs/v2.0/04 §9 开放项）。
 */
export interface LlmCompositionDto {
  /** 系统提示词（字符串长度 ÷ 4）。 */
  system: number;
  /** 工具 schema（每个 `{ name, description, inputSchema }` 的 JSON 长度 ÷ 4 求和）。 */
  tools: number;
  /** 用户消息正文（含记忆/检索/skill 等注入内容——注入后与普通 user 消息在最终形态上不可区分）。 */
  user: number;
  /** 历史 assistant 回复。 */
  assistant: number;
  /** 历史工具结果。 */
  toolResult: number;
  /** 五项之和。 */
  total: number;
}

/**
 * 窗口参数：随每次调用落盘，是 Trace 上下文面板的单一事实源（对齐 `@aiagent/ai` 的 `Model`）。
 *
 * 必填而非可选：serve 在**构造 wrapper 时**即注入该参数，与单次请求成败无关——
 * 提前失败（未发请求）的调用同样能给出窗口口径，web 端因此无需为缺失分支降级。
 */
export interface LlmWindowDto {
  /** 模型全窗口（contextWindow）。 */
  contextWindow: number;
  /** 输出预算（maxTokens，位于 contextWindow 之外的输出窗）。 */
  maxTokens: number;
  /** 压缩预留（compaction settings 的 reserveTokens）。 */
  reserveTokens: number;
}

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
  /**
   * 发起本次调用的 agent 身份（跨 Agent 归因锚点；supervisor 根节点为 "supervisor"）。
   *
   * **可空是对错误路径的忠实建模，不是兼容分支**：上游同步 throw、流提前结束等情形下
   * 请求可能根本没走到 onPayload，身份与构成在采集时刻物理上不存在；消费侧缺省归
   * supervisor 根节点（docs/v2.0/04 §1.1）。
   */
  agentId?: string;
  /**
   * 窗口构成快照（采集层在 onPayload 现算，见 `estimateComposition`）。
   *
   * 可空理由同上：错误早退时尚未拿到最终 context，构成无从计算。
   */
  composition?: LlmCompositionDto;
  /** 窗口参数（serve 构造 wrapper 时注入，必填；请求成败与提前失败都不影响其存在）。 */
  window: LlmWindowDto;
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
