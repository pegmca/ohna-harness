import type {
  ApiError,
  LinearMessageDto,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";

/**
 * 时间线消息的 role 词表，锚定到 @aiagent/types 的权威 role 定义
 * （LinearMessageDto.role = "user" | "assistant" | "toolResult"），
 * 取 web 实际使用的子集。前端不再自创字面量，避免与权威定义漂移。
 */
export type MessageRole = Extract<LinearMessageDto["role"], "user" | "assistant">;

/**
 * UI 渲染生命周期状态（前端本地），区别于 @aiagent/types 的
 * ConversationMessageStatusDto（持久化终态 completed/failed）。
 * 含 pending（流式进行中）、cancelled（用户取消）等仅存在于前端的流式中间态。
 */
export type UiMessageStatus = "complete" | "pending" | "failed" | "cancelled";

/**
 * pi content 块的前端窄类型（apps/ohna-web 不依赖 packages/ai，仅声明渲染所需字段）。
 * 与 `packages/ai/src/types.ts` 的 TextContent / ThinkingContent / ToolCall 对齐。
 */
export interface UiTextBlock {
  type: "text";
  text: string;
}

export interface UiThinkingBlock {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

/** toolResult 配对到 toolCall 后的结果摘要；历史与 live 共用。 */
export interface UiToolResult {
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError: boolean;
  details?: unknown;
}

export interface UiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 配对的 toolResult；live 期间由 tool_execution_end 或历史 toolResult 消息填充。 */
  result?: UiToolResult;
  /** live 执行状态；历史消息一律视为 completed。 */
  status?: "running" | "completed" | "failed";
}

export type UiContentBlock = UiTextBlock | UiThinkingBlock | UiToolCallBlock;

/**
 * 时间线消息：user 承载文本，assistant 承载 content 块（含配对的 toolResult），
 * compaction 行渲染为「历史已压缩」分隔条。
 */
export interface UiMessage {
  id: string;
  role: MessageRole;
  /**
   * user 正文文本；assistant 的纯文本摘要（text 块拼接或错误/进度文案），供复制操作使用。
   *
   * 失败态两态约定（由 `format.ts` 的 `applyFailure` 统一构造）：
   * - 有残留文本：正文即残留文本，结构化错误另见 {@link UiMessage.error}；
   * - 无残留文本：正文即 `formatApiError(error)`，此时 `error` 为 undefined，错误只此一处。
   */
  content: string;
  /** assistant 结构化内容块。 */
  blocks: UiContentBlock[];
  createdAt: string;
  status: UiMessageStatus;
  kind?: "normal" | "compaction";
  ok?: boolean;
  runId?: string;
  /** live 期间收到的 canonical run_event envelope，供 live 投影与滚动跟随派生。 */
  liveEvents?: RunStreamEventDtoV2[];
  /** 最近一次 run 状态，用于 header 徽标。 */
  runStatus?: RunStatusDtoV2;
  /**
   * 结构化错误（run_error / snapshot.error），供气泡 error-block 渲染。
   *
   * 只在失败 run 产生了残留文本时设置：同一错误不得在 {@link UiMessage.content}
   * 与 error-block 两处重复展示，无残留文本时错误由 content 承载、本字段为 undefined。
   */
  error?: ApiError;
  modelId?: string;
  /** 失败消息重试所需的输入快照（本地无附件，只需原文与模型）。 */
  retryContext?: RetryRunContext;
}

/** 失败消息重试所需的不可变 Run 输入快照，避免读取已变化的 Composer 状态。 */
export interface RetryRunContext {
  message: string;
  modelId: string;
}

