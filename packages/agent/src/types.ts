/**
 * Agent loop 类型定义：形状对齐 pi（badlogic/packages/agent/src/types.ts）的裁剪版。
 *
 * 与 pi 的差异：
 * - AgentTool / AgentToolResult 定义在 @aiagent/tools（工具契约属于工具包），此处
 *   `import type` 后原样 re-export，避免 agent→tools 的运行时反向依赖成包级环；
 * - AgentMessage 扩展了 CompactionMessage（compaction 摘要消息，见 compaction.ts）；
 * - 裁剪掉 pi 的有状态 Agent 包装相关类型（AgentState/QueueMode/CustomAgentMessages），
 *   本项目会话状态以 Postgres 线性消息为准，只要纯函数 loop。
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ToolResultMessage,
} from "@aiagent/ai";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@aiagent/tools";
import type { CompactionMessage } from "./compaction.js";

export type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@aiagent/tools";
export type { ThinkingLevel, ModelThinkingLevel } from "@aiagent/ai";

/**
 * loop 使用的流式函数签名；@aiagent/ai 的 streamSimple 满足该形状。
 *
 * 契约（对齐 pi StreamFn）：
 * - 请求/模型/运行时失败不得 throw 或 reject；
 * - 必须返回 AssistantMessageEventStream；
 * - 失败编码进事件流，以 stopReason "error"/"aborted" 的 AssistantMessage 收尾。
 */
export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** assistant 消息中的单个 toolCall 内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * AgentMessage：LLM 三元组 + CompactionMessage（transformContext 产出的压缩摘要，
 * 在 convertToLlm 中转成一条 user 消息，对齐 pi buildSessionContext 的做法）。
 */
export type AgentMessage = Message | CompactionMessage;

/** 传给 loop 的上下文快照。 */
export interface AgentContext {
  systemPrompt: string;
  /** 对模型可见的消息序列（loop 会直接 push 新消息进去）。 */
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}

/** beforeToolCall 的返回值；block 为 true 时工具不执行，回喂 isError 结果。 */
export interface BeforeToolCallResult {
  block?: boolean;
  /** block 原因，成为错误 ToolResultMessage 的文本。 */
  reason?: string;
}

/**
 * afterToolCall 的部分覆盖结果：逐字段替换（content/details/isError/usage/terminate），
 * 缺省字段保留原执行结果，不做深合并（对齐 pi）。
 */
export interface AfterToolCallResult {
  content?: AgentToolResult["content"];
  details?: unknown;
  isError?: boolean;
  usage?: AgentToolResult["usage"];
  terminate?: boolean;
}

/** beforeToolCall 的钩子上下文。 */
export interface BeforeToolCallContext {
  /** 发起该工具调用的 assistant 消息。 */
  assistantMessage: AssistantMessage;
  /** assistantMessage.content 中的原始 toolCall 块。 */
  toolCall: AgentToolCall;
  /** 通过 zod 校验后的工具参数。 */
  args: unknown;
  /** 工具调用 prepare 时刻的 agent 上下文。 */
  context: AgentContext;
}

/** afterToolCall 的钩子上下文。 */
export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  /** 未应用 afterToolCall 覆盖前的执行结果。 */
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

/** shouldStopAfterTurn 的钩子上下文。 */
export interface ShouldStopAfterTurnContext {
  /** 本轮完成的 assistant 消息。 */
  message: AssistantMessage;
  /** 随本轮 turn_end 发出的工具结果消息。 */
  toolResults: ToolResultMessage[];
  /** 本轮 assistant 消息与工具结果已追加后的上下文。 */
  context: AgentContext;
  /** 若此刻退出，本次 loop 调用将返回的消息集（prompt run 含 prompt 本身）。 */
  newMessages: AgentMessage[];
}

/** prepareNextTurn 的钩子上下文（与 shouldStopAfterTurn 相同，对齐 pi）。 */
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/** prepareNextTurn 可替换的下轮运行状态。 */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: Model<Api>;
  /** "off" 表示关闭 reasoning。 */
  thinkingLevel?: import("@aiagent/ai").ModelThinkingLevel;
}

/**
 * Agent loop 配置：钩子签名与 pi AgentLoopConfig 一致，另加本项目的 deadlineMs。
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<Api>;
  /**
   * AgentMessage[] → LLM Message[]，每次 LLM 调用前执行（必填）。
   * 不可转换的自定义消息在此过滤；CompactionMessage 在此转 user 消息。
   * convert.ts 导出 defaultConvertToLlm（透传三元组 + 转换摘要）可直接使用。
   * 契约：不得 throw/reject，返回安全兜底值。
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /**
   * LLM 调用前的 AgentMessage 级变换（裁剪/注入/compaction）。
   * 挂载点①：RAG 附件 grounding；挂载点②：compaction 检查与触发
   * （compaction.ts 的 createCompactionTransform 可直接挂在这里）。
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** 每次调用动态解析 API key（短寿命 token）。 */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /**
   * turn 结束后优雅停止（返回 true 则 emit agent_end 退出）。
   * 挂载点③：deadlineMs 到期检查 + maxTurns 预算。
   */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  /** turn 结束后替换下一轮的 context/model/thinkingLevel。 */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /** 挂载点④：拉取运行中用户中途输入，注入下一轮 LLM 调用前。 */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /** run 将结束时拉取排队消息，有则注入并继续跑。 */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /** 批内执行模式，默认 parallel；批内任一工具 sequential 则整批降级串行。 */
  toolExecution?: ToolExecutionMode;
  /**
   * 挂载点⑤：校验后执行前；仅观测与 block（dangerous 工具 denylist、限流），
   * 不接任何审批逻辑（approval 体系已删除）。
   */
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  /** 挂载点⑥：citation 提取、trace 补充 details；逐字段覆盖执行结果。 */
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  /** 本项目新增（pi 无）：run 总 deadline 毫秒数，由 run 层换算成截止时刻并在钩子里检查。 */
  deadlineMs?: number;
}

/**
 * agent loop 兜底错误的结构化描述：钩子违反「不得抛错」契约导致 runAgentLoop reject 时，
 * agentLoop 补发带该错误的 agent_end，调用方可据此区分正常结束与兜底结束。
 */
export interface AgentLoopError {
  /** 稳定错误码（当前为 agent_loop_aborted）。 */
  code: string;
  message: string;
}

/**
 * Agent loop 事件流契约（对齐 pi AgentEvent）。
 * `agent_end` 是 run 的终止事件，携带本次 run 新产生的全部消息；
 * `error` 仅在兜底收尾（钩子抛错）时出现，正常结束为 undefined。
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; error?: AgentLoopError }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  /** 仅 assistant 流式期间发出。 */
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };
