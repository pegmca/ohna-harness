export interface TraceSummary {
  packageName: string;
  eventCount: number;
}

export interface Trace {
  traceId: string;
  requestId: string;
  startedAt: string;
  events: TraceEvent[];
}

export type TraceEventType =
  | "request_received"
  | "intent_routed"
  | "agent_step"
  | "retrieval"
  | "model_call"
  | "tool_call"
  | "final_response";

export interface TraceError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface TraceEventBase {
  type: TraceEventType;
  id: string;
  traceId: string;
  requestId: string;
  createdAt: string;
}

export interface TraceRequestReceivedEvent extends TraceEventBase {
  type: "request_received";
  userMessage: string;
  inputPreview: string;
}

export interface TraceIntentRoutedEvent extends TraceEventBase {
  type: "intent_routed";
  intent: string;
  confidence: number;
  reason: string;
  toolName?: string;
}

export interface TraceAgentStepEvent extends TraceEventBase {
  type: "agent_step";
  stepIndex: number;
  stepType: string;
  status: "started" | "succeeded" | "failed";
  durationMs: number;
  error?: TraceError;
  data?: Record<string, unknown>;
}

export interface TraceRetrievalScoreSummary {
  chunkId: string;
  vectorScore: number;
  keywordScore: number;
  hybridScore: number;
  rerankScore?: number;
  finalScore: number;
  rank: number;
}

export interface TraceRetrievalEvent extends TraceEventBase {
  type: "retrieval";
  queryPreview: string;
  mode: "vector" | "keyword" | "hybrid";
  topK: number;
  candidateLimit: number;
  durationMs: number;
  chunkIds: string[];
  scoreSummary: TraceRetrievalScoreSummary[];
  ok: boolean;
  error?: TraceError;
}

export interface TraceModelCallEvent extends TraceEventBase {
  type: "model_call";
  model: string;
  purpose: string;
  durationMs: number;
  ok: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: TraceError;
}

export interface TraceToolCallEvent extends TraceEventBase {
  type: "tool_call";
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  error?: TraceError;
}

export interface TraceFinalResponseEvent extends TraceEventBase {
  type: "final_response";
  answerPreview: string;
  ok: boolean;
  error?: TraceError;
}

export type TraceEvent =
  | TraceRequestReceivedEvent
  | TraceIntentRoutedEvent
  | TraceAgentStepEvent
  | TraceRetrievalEvent
  | TraceModelCallEvent
  | TraceToolCallEvent
  | TraceFinalResponseEvent;

export interface TraceRecorder {
  readonly traceId: string;
  readonly requestId: string;
  /**
   * 记录单个 trace event，调用方不需要知道 recorder 的存储细节。
   *
   * @param event 要追加到当前 trace 的事件。
   */
  record(event: TraceEvent): void;
  /**
   * 读取当前 trace 的事件快照，避免外部直接修改内部数组。
   *
   * @returns 当前 trace 下的事件列表。
   */
  getEvents(): TraceEvent[];
  /**
   * 读取可直接返回前端的一次请求 trace 快照。
   *
   * @returns 包含 request id 和事件时间线的 trace。
   */
  getTrace(): Trace;
}

/**
 * 创建 trace 摘要，当前用于验证 trace package 边界已经可被其他 package 引用。
 *
 * @returns trace package 的最小摘要信息。
 */
export function createTraceSummary(): TraceSummary {
  return {
    packageName: "@aiagent/trace",
    eventCount: 0
  };
}

/**
 * 创建内存 trace recorder，供本地开发、mock 工具和后续前端 timeline 消费。
 *
 * @param traceId 一次请求或一次手动验证的稳定 trace 标识。
 * @param requestId 对外请求标识，默认与 traceId 一起生成，便于 Week 4 接入 API 网关。
 * @returns 可记录并读取事件的内存 recorder。
 */
export function createInMemoryTraceRecorder(traceId = createTraceId(), requestId = createRequestId()): TraceRecorder {
  const events: TraceEvent[] = [];
  const startedAt = new Date().toISOString();

  /**
   * 追加单个 trace event，保持 recorder 实现对调用方透明。
   *
   * @param event 要记录的事件。
   */
  function record(event: TraceEvent): void {
    events.push(sanitizeTraceEvent(event));
  }

  /**
   * 返回事件快照，避免调用方修改 recorder 内部状态。
   *
   * @returns 当前 trace 的事件列表。
   */
  function getEvents(): TraceEvent[] {
    return [...events];
  }

  /**
   * 返回一次请求的完整 trace 快照，前端只消费这个稳定结构。
   *
   * @returns 当前 trace 快照。
   */
  function getTrace(): Trace {
    return {
      traceId,
      requestId,
      startedAt,
      events: getEvents()
    };
  }

  return {
    traceId,
    requestId,
    record,
    getEvents,
    getTrace
  };
}

/**
 * 生成轻量 trace id，避免引入运行时依赖并保持浏览器/Node 都可用。
 *
 * @returns 带 trace_ 前缀的请求链路标识。
 */
export function createTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成轻量 request id，后续可替换为 API 网关传入的请求标识。
 *
 * @returns 带 req_ 前缀的请求标识。
 */
export function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 对 trace event 做集中脱敏，避免工具参数或错误 details 意外携带密钥。
 *
 * @param event 原始 trace event。
 * @returns 脱敏后的 trace event。
 */
function sanitizeTraceEvent(event: TraceEvent): TraceEvent {
  return sanitizeValue(event) as TraceEvent;
}

/**
 * 递归复制并脱敏对象，保持 recorder 外部传入对象不会被修改。
 *
 * @param value 未信任的 trace 字段值。
 * @returns 可安全保存在 trace 中的值。
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(child);
  }

  return sanitized;
}

/**
 * 识别常见敏感字段名，避免 API key、token、密码或 Authorization 头进入 trace。
 *
 * @param key 对象字段名。
 * @returns 是否应脱敏。
 */
function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|password|secret|token/i.test(key);
}
