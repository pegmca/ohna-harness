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
  | "mcp_tool_discovered"
  | "cost_summary";

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
  /**
   * 当前 run 的 loop 配置快照；具体内容由 agent 包定义。
   * 为对齐 OTel `gen_ai` semconv（P1），payload 开放 model/api/agentName 可选字段，
   * 其余 loop 配置仍用索引签名保持开放、向后兼容。
   */
  payload: {
    /** 本次 run 使用的请求模型，映射到 `gen_ai.request.model`。 */
    model?: string;
    /** 底层 api 标识（如 openai-completions），用于推导 `gen_ai.system`。 */
    api?: string;
    /** agent 名称（可选），映射到 `gen_ai.agent.name`。 */
    agentName?: string;
    [key: string]: unknown;
  };
}

/** Agent 循环结束事件。 */
export interface AgentEndEvent extends RunEventBase {
  type: "agent_end";
  /**
   * 本轮最终消息列表与收尾统计；具体内容由 agent 包定义。
   * 为对齐 OTel `gen_ai` semconv（P1），开放 model/usage/cost 可选字段。
   */
  payload: {
    /** 响应模型名，映射到 `gen_ai.response.model`。 */
    model?: string;
    /** 本轮 token 用量，映射到 `gen_ai.token.count.*`。 */
    usage?: TraceTokenUsage;
    /** 本轮成本，映射到 `cost.total`。 */
    cost?: TraceCost;
    [key: string]: unknown;
  };
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
  /**
   * 本轮生成的消息与统计；具体内容由 agent 包定义。
   * 为对齐 OTel `gen_ai` semconv（P1），开放 model/usage/cost 可选字段，
   * 便于把单次 generation 映射为 `gen_ai.agent.generation` span。
   */
  payload: {
    /** 请求/响应模型名，映射到 `gen_ai.request.model` / `gen_ai.response.model`。 */
    model?: string;
    /** 本次 generation 的 token 用量。 */
    usage?: TraceTokenUsage;
    /** 本次 generation 的成本。 */
    cost?: TraceCost;
    [key: string]: unknown;
  };
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
  /**
   * 工具执行结果；具体内容由 agent 包定义。
   * 为对齐 OTel `gen_ai` semconv（P1），开放 usage/cost 可选字段，
   * 便于把单次工具调用映射为 `gen_ai.tool.call` span 并带成本。
   */
  payload: {
    /** 本次工具调用的 token 用量（可选）。 */
    usage?: TraceTokenUsage;
    /** 本次工具调用的成本（可选）。 */
    cost?: TraceCost;
    [key: string]: unknown;
  };
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

/**
 * 成本归因汇总能力事件（P3）：run 终态时由 run-service 在线累加产出，
 * 按 model / tool 两个维度给出 token 与成本拆分，以及整体合计。
 * payload 与旧 trace 脱敏策略兼容（纯数字统计，无 PII），并作为跨边界 DTO 直接序列化。
 */
export interface CostSummaryEvent extends RunEventBase {
  type: "cost_summary";
  payload: {
    /** 按模型聚合：key 为 model 名，值为该模型的 token 与成本拆分。 */
    byModel: Record<string, { input: number; output: number; totalTokens: number; cost: number }>;
    /** 按工具聚合：key 为 toolName，值为该工具的 token 与成本拆分。 */
    byTool: Record<string, { input: number; output: number; totalTokens: number; cost: number }>;
    /** 全部事件合计 token 数。 */
    totalTokens: number;
    /** 全部事件合计成本。 */
    totalCost: number;
    /**
     * 本次 run 端到端时延（毫秒）：从 run-service 拿到执行许可到 agent_end 的墙钟时间。
     * 与成本同为观测性证据——闭合 docs/v1.2 §3 差距#7「无真实容量/SLO 证据」，供数据化叙事。
     * 非有限/缺失时 run-service 不并入，避免污染既有事件。
     */
    durationMs?: number;
    /** 本次 run 的 turn 数（assistant 消息数），用于估算单次交互的轮次成本与复杂度。 */
    turnCount?: number;
    /**
     * run 终态：completed / failed / interrupted。受控推导——发过 run_error 为 failed，
     * 取消信号置位为 interrupted，其余为 completed（防御式默认 completed）。
     */
    outcome?: "completed" | "failed" | "interrupted";
    /**
     * 本 run 结束时仍在执行中的活跃 run 数（容量快照）。取自 executionRegistry 在 agent_end 的计数，
     * 反映「同时在线负载」，是并发/吞吐容量证据的第一手样本。
     */
    activeRuns?: number;
    /**
     * 本 run 期间观测到的活跃 run 峰值（容量证据）。run-service 在事件循环内周期采样
     * executionRegistry 计数取峰值，比 end 时单点 activeRuns 更能暴露并发压力。
     */
    peakConcurrency?: number;
    /**
     * 多代理团队成本投影（可选）：仅当一次 run 真实使用了 team / SendMessage 子代理时才并入。
     * 事件即真相源——run-service 在 agent_end 把各成员用量累加进此段，看板可直接读取
     * 「多代理 15× token 必须收口」的收敛证据，无需回查 team 状态。形状由 agent 包的
     * `projectTeamCostSummary` 对齐产出，trace 包不反向依赖 agent/ai（维持单向依赖）。
     */
    team?: {
      /** 各成员成本明细。 */
      members: Array<{ name: string; model: string; tokens: number; cost: number; budgetExceeded: boolean; /** 该成员本次运行墙钟时长（毫秒），多代理时延归因用。 */ durationMs?: number }>;
      /** 团队成员 token 合计。 */
      totalTokens: number;
      /** 团队成员成本合计。 */
      totalCost: number;
      /**
       * 本次团队运行观测到的在飞成员峰值（多代理并发/容量证据）。来自 controller 维护的
       * runningMembers 在飞数峰值，反映「一次 supervisor 编排实际并发了多少子代理」。
       */
      peakConcurrency?: number;
    };
    /**
     * 上下文预算可观测投影（可选）：仅当集成方传入 budgetMetricSink（即装配了 context-assembly）
     * 时并入。聚合多次 transform 产出的 ContextBudgetReport：样本数、平均记忆命中率、平均检索丢弃率、
     * 超预算份数、发生丢弃的份数。当前 app 默认未装配 context-assembly，故常规 run 省略此段——这是
     * 有意的分层（受控钩子），非缺陷。
     */
    contextBudget?: {
      /** 样本数（report 份数）。 */
      count: number;
      /** 平均记忆命中率。 */
      averageMemoryHitRate: number;
      /** 平均检索丢弃率。 */
      averageDiscardRate: number;
      /** 注入 token 超过预算上限的份数（健全性校验，理论应为 0）。 */
      overBudgetCount: number;
      /** 出现检索被丢弃（discardRate > 0）的份数。 */
      discardedCount: number;
    };
  };
}

/**
 * trace 层 token 用量快照：对齐 @aiagent/ai 的 `Usage` 子集，作为跨边界 DTO。
 * 放在 trace 包内定义，避免反向依赖 ai 包（保持单向依赖）。
 */
export interface TraceTokenUsage {
  /** 输入 token 数。 */
  input: number;
  /** 输出 token 数。 */
  output: number;
  /** 缓存读命中 token 数（可选）。 */
  cacheRead?: number;
  /** 缓存写 token 数（可选）。 */
  cacheWrite?: number;
  /** 合计 token 数（按 input+output 或 provider 口径）。 */
  totalTokens: number;
  /** 按 token 计的成本明细（可选）。 */
  cost?: { input?: number; output?: number; total?: number };
}

/** trace 层成本快照：跨边界 DTO，仅保留总成本口径。 */
export interface TraceCost {
  /** 总成本（货币单位由调用方约定，通常为 USD）。 */
  total?: number;
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
  | McpToolDiscoveredEvent
  | CostSummaryEvent;

const MAX_TRACE_STRING_LENGTH = 500;

/**
 * 识别常见敏感字段名，避免 API key、token、密码或 Authorization 头进入 trace 或日志。
 *
 * 除原有机密/令牌类键外，额外把模型 I/O 文本常见的 JSON 键（`prompt` / `completion` /
 * `messages` / `content` / `output` / `input` / `answer`）也判为敏感键——这些键的值通常是
 * 模型输入/输出文本，常夹带用户 PII。命中时整值脱敏（"token 级 PII" 治理）。
 * 注意：键名匹配带边界（行首/`_`/`-` 或行尾/`_`/`-`），避免误伤 `inputValidation` 等复合键。
 *
 * @param key 对象字段名。
 * @returns 是否应脱敏。
 */
export function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|password|secret|session|cookie|(^|[-_])(access[-_]?token|refresh[-_]?token|token)($|[-_])|(^|[-_])(prompt|completion|messages|content|output|input|answer)($|[-_])/i.test(key);
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
    // 命中敏感键时仅当值为字符串才整值脱敏（PII 文本）；数字/数组/对象仍递归保留，
    // 避免误把 usage.input/output 等数字 token 计数、messages 数组整值替换为 "[redacted]" 造成落库数据损坏。
    sanitized[key] =
      isSensitiveKey(key) && typeof child === "string" ? "[redacted]" : sanitizeValue(child);
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

/**
 * "模型 token 轨迹"级别脱敏入口：当前实现直接复用 `redactSensitiveValue` 的同一递归脱敏核心
 * （`sanitizeValue`），并不额外提供更强的脱敏强度——两者等价。
 *
 * 对外提供 token 轨迹级脱敏入口的意义在于：把"模型 I/O 文本/单条消息"这类高频敏感场景收敛到
 * 一个语义明确的 API，未来可在此处独立增强（例如对全部字符串值强制跑一遍 PII 模式脱敏
 * `redactSensitiveText`、或对命中敏感键的对象做更激进的整形），而不影响 `redactSensitiveValue`
 * 的既有语义。
 *
 * @template TValue 输入值类型。
 * @param value 可能含 token 级 PII 的值（如单条消息、模型输入输出文本）。
 * @returns 深拷贝后的脱敏值（调用方原对象不会被修改）。
 */
export function redactTokenTrace<TValue>(value: TValue): TValue {
  return sanitizeValue(value) as TValue;
}

// OTel `gen_ai` semconv 映射层（P1）：把 RunEvent 投影为 Phoenix/OTel 兼容的 span，
// 与现有 trace 脱敏共用同一包，避免跨包耦合。
export { toOtelSpan, runEventsToOtelSpans } from "./otel-semconv.js";
export type { OtelSpan } from "./otel-semconv.js";

