/**
 * 工具契约类型：AgentTool / AgentToolResult 定义在工具包（工具契约属于工具方）。
 * packages/agent 仅 `import type` 后原样 re-export，避免 agent→tools 运行时反向依赖成环。
 * 形状对齐 pi（badlogic/packages/agent/src/types.ts），唯一差异：parameters 持 zod schema（zod v4），
 * zod → JSON Schema 的转换收敛在 packages/agent/src/convert.ts 一处。
 */
import type { ImageContent, TextContent, Usage } from "@aiagent/ai";
import type { z } from "zod";

/** 工具批执行模式：默认 parallel；批内任一工具声明 sequential 则整批降级串行（对齐 pi）。 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 工具结果：content 回喂模型，details 仅供 trace/UI，不进 LLM 上下文。
 */
export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  /** 工具自身执行的用量（如有）；不参与主 LLM 上下文计费。 */
  usage?: Usage;
  /** 提前结束提示：批次内全部结果为 true 才终止 run（对齐 pi shouldTerminateToolBatch）。 */
  terminate?: boolean;
  /** 工具级错误标记：为 true 时结果为错误内容（如数据源未配置），交由 loop 回喂模型。 */
  isError?: boolean;
}

/**
 * 工具流式部分结果回调；作用域为单次 execute() 调用，settle 后的调用被忽略。
 */
export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

/**
 * Agent 运行时工具定义。与 pi 的唯一差异：parameters 持 zod schema 而非 typebox。
 * 序列化为 JSON Schema 发生在 LLM 调用边界（packages/agent/src/convert.ts 的 toLlmTools），
 * loop 内与落库始终持 zod。
 */
export interface AgentTool<TSchema extends z.ZodType = z.ZodType, TDetails = unknown> {
  name: string;
  description: string;
  /** 面向 UI 展示的可读名称。 */
  label: string;
  /** zod 参数 schema；loop 在执行前用它校验模型给出的参数。 */
  parameters: TSchema;
  /** 原始参数兼容 shim，zod 校验前调用（对齐 pi prepareArguments）。 */
  prepareArguments?: (args: unknown) => z.infer<TSchema>;
  /**
   * 执行工具真实逻辑；失败时抛异常，由 loop 转成 isError 的 ToolResultMessage 回喂模型。
   *
   * @param toolCallId 本次工具调用 id（来自 assistant 消息的 toolCall 块）。
   * @param params 已通过 zod 校验的参数。
   * @param signal run 级 AbortSignal，工具应响应取消。
   * @param onUpdate 可选的部分结果回调，用于长耗时工具的进度观测。
   * @returns 结构化工具结果。
   */
  execute: (
    toolCallId: string,
    params: z.infer<TSchema>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** 默认 parallel；任一为 sequential 则整批降级为串行。 */
  executionMode?: ToolExecutionMode;
  /** 数据来源标记：real 表示真实 adapter，mock 表示确定性假数据；v1.2 起统一为 real。 */
  source?: "real" | "mock";
}

/** 工具执行错误码：withTimeoutAndRetry 抛出的 Error.code 取自这里。 */
export type ToolErrorCode =
  | "tool_not_found"
  | "validation_error"
  | "output_validation_error"
  | "execution_error"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "deadline_exceeded"
  | "retry_exhausted";

/** 结构化工具错误（withTimeoutAndRetry 以带 code 的 Error 抛出，不落 DTO）。 */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 重试策略：指数退避 + 抖动。 */
export interface ToolRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/** withTimeoutAndRetry 的执行选项（由 defineAgentTool 或调用方给出）。 */
export interface ToolExecutionOptions {
  /** 单次执行超时毫秒数，默认 10000。 */
  timeoutMs?: number;
  /** 总 deadline（绝对毫秒时刻）；单次预算取 min(timeoutMs, 剩余 deadline)。 */
  deadlineAtMs?: number;
  /** 重试策略覆盖。 */
  retry?: Partial<ToolRetryPolicy>;
  /** 工具是否有副作用；有副作用工具只有声明幂等且提供幂等键才可重试。 */
  hasSideEffects?: boolean;
  /** 声明 execute 在相同幂等键下可安全重放。 */
  idempotent?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** 测试注入：时钟。 */
  now?: () => number;
  /** 测试注入：可中断的 sleep。 */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface ToolRegistrySummary {
  packageName: string;
  availableTools: number;
  toolNames: string[];
}
