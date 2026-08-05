/**
 * @aiagent/trace 阶段 6 收敛：不再承担 TraceRecorder/TraceStore/Trace 汇总职责，
 * 仅保留运行事件类型契约与敏感信息脱敏工具，作为跨包可复用的观测/安全边界。
 *
 * 设计约束：
 * - 不导入 @aiagent/agent / @aiagent/ai，避免与模型/循环层循环依赖；
 * - loop 事件 payload 用 unknown，由消费侧按 AgentEvent 断言；
 * -  capability 扩展事件保留最小字段，方便 run_events 直接序列化。
 */

/** run_events 生命周期与 loop 事件类型枚举。 */
export type RunEventType =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "run_status"
  | "run_error"
  | "retrieval"
  | "workflow_node"
  | "pdf_export"
  | "mcp_tool_discovered";

/** 所有运行事件共有的 envelope 字段。 */
interface RunEventBase {
  /** 事件类型，对应 run_events.event_type。 */
  type: RunEventType;
  /** 事件在 trace/run 内的唯一标识。 */
  id: string;
  /** 关联 trace 标识；无 trace 上下文时用占位值。 */
  traceId: string;
  /** 对外请求标识。 */
  requestId: string;
  /** 可选的 span 标识，用于后续分布式追踪扩展。 */
  spanId?: string;
  /** 父 span 标识。 */
  parentSpanId?: string;
  /** 事件产生阶段，便于定位问题。 */
  stage?: string;
  /** ISO 8601 时间戳。 */
  createdAt: string;
}

/** Agent 循环开始事件。 */
export interface AgentStartEvent extends RunEventBase {
  type: "agent_start";
  /** 当前 run 的 loop 配置快照；具体内容由 agent 包定义。 */
  payload: unknown;
}

/** Agent 循环结束事件。 */
export interface AgentEndEvent extends RunEventBase {
  type: "agent_end";
  /** 本轮最终消息列表；具体内容由 agent 包定义。 */
  payload: unknown;
}

/** 单个 turn 开始事件。 */
export interface TurnStartEvent extends RunEventBase {
  type: "turn_start";
  payload: unknown;
}

/** 单个 turn 结束事件。 */
export interface TurnEndEvent extends RunEventBase {
  type: "turn_end";
  payload: unknown;
}

/** 消息开始生成事件。 */
export interface MessageStartEvent extends RunEventBase {
  type: "message_start";
  payload: unknown;
}

/** 消息内容增量事件。 */
export interface MessageUpdateEvent extends RunEventBase {
  type: "message_update";
  payload: unknown;
}

/** 消息生成结束事件。 */
export interface MessageEndEvent extends RunEventBase {
  type: "message_end";
  payload: unknown;
}

/** 工具执行开始事件。 */
export interface ToolExecutionStartEvent extends RunEventBase {
  type: "tool_execution_start";
  payload: unknown;
}

/** 工具执行中间更新事件。 */
export interface ToolExecutionUpdateEvent extends RunEventBase {
  type: "tool_execution_update";
  payload: unknown;
}

/** 工具执行结束事件。 */
export interface ToolExecutionEndEvent extends RunEventBase {
  type: "tool_execution_end";
  payload: unknown;
}

/** Run 生命周期状态事件。 */
export interface RunStatusEvent extends RunEventBase {
  type: "run_status";
  payload: {
    /** 当前 run 状态。 */
    status: string;
    /** 面向用户的状态说明。 */
    message?: string;
  };
}

/** Run 执行错误事件。 */
export interface RunErrorEvent extends RunEventBase {
  type: "run_error";
  payload: {
    /** 结构化错误。 */
    error: {
      code: string;
      message: string;
      stage?: string;
      details?: Record<string, unknown>;
    };
  };
}

/** RAG 检索能力事件；payload 与旧 TraceRetrievalEvent 同形状（不含 traceId/requestId）。 */
export interface RetrievalEvent extends RunEventBase {
  type: "retrieval";
  payload: {
    queryPreview: string;
    mode: "vector" | "keyword" | "hybrid";
    topK: number;
    candidateLimit: number;
    durationMs: number;
    chunkIds: string[];
    scoreSummary: Array<{
      chunkId: string;
      documentId?: string;
      vectorScore: number;
      keywordScore: number;
      hybridScore: number;
      rerankScore?: number;
      finalScore: number;
      rank: number;
    }>;
    ok: boolean;
    error?: {
      code: string;
      message: string;
      stage?: string;
      details?: Record<string, unknown>;
    };
  };
}

/** Workflow 节点执行能力事件。 */
export interface WorkflowNodeEvent extends RunEventBase {
  type: "workflow_node";
  payload: {
    workflowRunId: string;
    nodeId: string;
    nodeType: string;
    status: string;
    durationMs: number;
    inputSummary?: Record<string, unknown>;
    outputSummary?: Record<string, unknown>;
    error?: {
      code: string;
      message: string;
      nodeId?: string;
      details?: Record<string, unknown>;
    };
  };
}

/** PDF 导出能力事件。 */
export interface PdfExportEvent extends RunEventBase {
  type: "pdf_export";
  payload: {
    workflowRunId: string;
    status: "queued" | "started" | "succeeded" | "failed" | "not_implemented";
    fileName?: string;
    durationMs: number;
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
}

/** MCP 工具发现能力事件。 */
export interface McpToolDiscoveredEvent extends RunEventBase {
  type: "mcp_tool_discovered";
  payload: {
    serverName: string;
    toolNames: string[];
    ok: boolean;
    durationMs: number;
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
}

/** Run 事件联合类型；消费侧按 type 收窄。 */
export type RunEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | RunStatusEvent
  | RunErrorEvent
  | RetrievalEvent
  | WorkflowNodeEvent
  | PdfExportEvent
  | McpToolDiscoveredEvent;

const MAX_TRACE_STRING_LENGTH = 500;

/**
 * 识别常见敏感字段名，避免 API key、token、密码或 Authorization 头进入 trace 或日志。
 *
 * @param key 对象字段名。
 * @returns 是否应脱敏。
 */
function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|password|secret|session|cookie|(^|[-_])(access[-_]?token|refresh[-_]?token|token)($|[-_])/i.test(key);
}

/**
 * 对字符串中的常见 secret 与 PII 做模式脱敏。
 *
 * @param value 原始字符串。
 * @returns 脱敏后的字符串。
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "Cookie: [redacted]")
    .replace(/\b(aiagent_session|session(?:id)?)\s*=\s*[^;\s]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk[-_][A-Za-z0-9_-]{12,}|api[-_]?key[-_][A-Za-z0-9_-]{12,})\b/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted:email]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)(?!\s*(?:CNY|RMB|元|万元|亿元|%|股))/g, "[redacted:phone]")
    .replace(/(?<![A-Z0-9])\d{17}[0-9Xx](?![A-Z0-9])/g, "[redacted:id]")
    .replace(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, "[redacted:account]");
}

/**
 * 递归复制并脱敏对象，保持调用方传入对象不会被修改。
 *
 * @param value 未信任的字段值。
 * @returns 可安全保存/返回的值。
 */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === "string") {
    return truncate(redactSensitiveText(value));
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

function truncate(value: string): string {
  return value.length <= MAX_TRACE_STRING_LENGTH ? value : `${value.slice(0, MAX_TRACE_STRING_LENGTH)}…[truncated]`;
}

/**
 * 在日志、API 错误和报告输出边界复用与 trace 相同的递归脱敏策略。
 *
 * @template TValue 输入值类型。
 * @param value 可能包含 PII 或 secret 的值。
 * @returns 深拷贝后的脱敏值。
 */
export function redactSensitiveValue<TValue>(value: TValue): TValue {
  return sanitizeValue(value) as TValue;
}
