import type {
  ApiError,
  ConversationSummaryDto,
  LinearMessageDto,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type {
  UiContentBlock,
  UiMessage,
  UiTextBlock,
  UiThinkingBlock,
  UiToolCallBlock,
  UiToolResult
} from "./types";

/**
 * 把实时 run_event 转换为 assistant 消息中的简短进度文案。
 *
 * @param event canonical run event envelope。
 * @returns 用户可读进度。
 */
export function formatRunProgress(event: RunStreamEventDtoV2): string {
  const payload = (event.payload ?? {}) as { status?: string; message?: string; toolName?: string; error?: { message: string } };
  switch (event.type) {
    case "agent_start":
      return "已开始处理请求。";
    case "run_status":
      return payload.message ?? `运行状态：${payload.status ?? "unknown"}`;
    case "run_error":
      return payload.error?.message ?? "运行失败。";
    case "tool_execution_start":
      return `正在调用工具 ${payload.toolName ?? ""}。`;
    case "tool_execution_end":
      return `工具 ${payload.toolName ?? ""} 已返回。`;
    case "confirmation_requested":
      return "等待确认写/执行操作。";
    case "agent_end":
      return "回答完成。";
    default:
      return "正在生成回答。";
  }
}

/**
 * 格式化 API 错误，保留关键诊断字段但不暴露堆栈。
 *
 * @param error API 结构化错误。
 * @returns 面向用户和开发调试的错误文案。
 */
export function formatApiError(error: ApiError): string {
  const diagnostics = [
    typeof error.details?.status === "number" ? `status=${error.details.status}` : undefined,
    typeof error.details?.cause === "string" ? `cause=${error.details.cause}` : undefined
  ].filter(Boolean);

  return diagnostics.length > 0
    ? `${error.code}: ${error.message} (${diagnostics.join(", ")})`
    : `${error.code}: ${error.message}`;
}

/**
 * 格式化 ISO 时间；非法时间保持原值，避免 UI 抛错。
 *
 * @param value ISO 时间字符串。
 * @returns 本地时间文案。
 */
export function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

/**
 * 格式化较短的会话更新时间。
 *
 * @param value ISO 时间字符串。
 * @returns 简短时间文案。
 */
export function formatRelativeTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 把最近一次 run 状态转成 header 的状态文案。
 *
 * @param status 最近一次 run 状态。
 * @returns 状态文案。
 */
export function formatRunStatus(status: RunStatusDtoV2 | undefined): string {
  return status ?? "idle";
}

/**
 * 从第一条用户输入生成会话标题。
 *
 * @param message 用户输入。
 * @returns 会话标题。
 */
export function createConversationTitle(message: string): string {
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}

/**
 * 把线性消息页转换为 UI 消息列表：toolResult 行按 toolCallId 并入前一条 assistant 消息的
 * toolCall 块，compaction 行转换为分隔条消息。
 *
 * @param items 服务端线性消息（按时间线顺序）。
 * @returns UI 时间线消息。
 */
export function toUiMessages(items: LinearMessageDto[]): UiMessage[] {
  const messages: UiMessage[] = [];
  // 同一 run 的中间助手消息（工具调用消息 + 总结消息等）归并到「一条用户消息 → 一条助手消息」，
  // 避免 Agent 调用循环产生的多段 assistant 在时间线渲染成多个头像（BUG-006）。
  // 归并以 runId 为锚：一个 run 对应一次用户回合，因此同一个 runId 的全部 assistant 段合并为一个气泡。
  let activeRun: { runId: string; message: UiMessage } | undefined;
  for (const item of items) {
    if (item.messageType === "compaction") {
      activeRun = undefined;
      messages.push({
        id: item.messageId,
        role: "user",
        content: "",
        blocks: [],
        createdAt: item.createdAt,
        status: "complete",
        kind: "compaction"
      });
      continue;
    }
    if (item.role === "toolResult") {
      const result = parseToolResult(item.content);
      // 历史里 toolResult 紧跟产出它的 assistant 消息；找不到配对时丢弃该行，不单独成气泡。
      if (result) attachToolResult(messages, result);
      continue;
    }
    if (item.role === "assistant") {
      const blocks = parseAssistantBlocks(item.content);
      const runId = item.runId ?? "";
      // 同 runId 的 assistant 段：累积块到当前归并气泡，不新建气泡（首个段确定气泡位置/id）。
      if (activeRun && activeRun.runId === runId) {
        activeRun.message.blocks = [...activeRun.message.blocks, ...blocks];
        activeRun.message.content = textOfBlocks(activeRun.message.blocks);
        // 任一段失败即判定整条失败，但保留已累积内容。
        if (item.stopReason === "error") activeRun.message.ok = false;
        continue;
      }
      const merged: UiMessage = {
        id: item.messageId,
        role: "assistant",
        content: textOfBlocks(blocks),
        blocks,
        createdAt: item.createdAt,
        status: item.stopReason === "error" ? "failed" : "complete",
        ok: item.stopReason !== "error",
        runId: item.runId,
        modelId: item.modelId
      };
      activeRun = { runId, message: merged };
      messages.push(merged);
      continue;
    }
    // 用户消息结束当前 run 的归并（新一轮换 runId，或回退到无 runId 的历史用户消息）。
    if (item.role === "user") activeRun = undefined;
    messages.push({
      id: item.messageId,
      role: "user",
      content: parseUserText(item.content),
      blocks: [],
      createdAt: item.createdAt,
      status: "complete",
      runId: item.runId
    });
  }
  return messages;
}

/**
 * 把 toolResult 配对到最近的 assistant 消息的同名 toolCall 块上。
 *
 * @param messages 已转换的 UI 消息（原地修改）。
 * @param result toolResult 摘要。
 * @returns 无返回值。
 */
function attachToolResult(messages: UiMessage[], result: UiToolResult): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== "assistant") continue;
    const block = candidate.blocks.find(
      (item): item is UiToolCallBlock => item.type === "toolCall" && item.id === result.toolCallId
    );
    if (!block) return;
    block.result = result;
    block.status = result.isError ? "failed" : "completed";
    return;
  }
}

/** @param content toolResult envelope。 @returns 解析出的结果摘要；形状不符时返回 undefined。 */
export function parseToolResult(content: unknown): UiToolResult | undefined {
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") return undefined;
  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    content: record.content,
    isError: record.isError === true,
    details: record.details
  };
}

/** @param content assistant content 块数组。 @returns 前端窄类型块（未知块类型被丢弃）。 */
export function parseAssistantBlocks(content: unknown): UiContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: UiContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push({ type: "text", text: record.text } satisfies UiTextBlock);
    } else if (record.type === "thinking" && typeof record.thinking === "string") {
      blocks.push({
        type: "thinking",
        thinking: record.thinking,
        redacted: record.redacted === true
      } satisfies UiThinkingBlock);
    } else if (record.type === "toolCall" && typeof record.id === "string" && typeof record.name === "string") {
      blocks.push({
        type: "toolCall",
        id: record.id,
        name: record.name,
        arguments: (record.arguments ?? {}) as Record<string, unknown>,
        status: "completed"
      } satisfies UiToolCallBlock);
    }
  }
  return blocks;
}

/** @param content user content（字符串或块数组）。 @returns 纯文本正文。 */
function parseUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map((item) => item.text)
    .join("\n");
}

/** @param blocks assistant 内容块。 @returns text 块拼接出的纯文本，供复制等操作使用。 */
export function textOfBlocks(blocks: UiContentBlock[]): string {
  return blocks
    .filter((block): block is UiTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** @param current 已加载会话。 @param incoming 新页。 @returns 按 ID 去重的列表。 */
export function mergeConversations(current: ConversationSummaryDto[], incoming: ConversationSummaryDto[]): ConversationSummaryDto[] {
  const seen = new Set(current.map((item) => item.conversationId));
  return [...current, ...incoming.filter((item) => !seen.has(item.conversationId))];
}

/** @param current 已加载消息。 @param incoming 新页。 @returns 按 ID 去重并按时间线顺序排列的消息。 */
export function mergeMessages(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

/**
 * 失败终态补丁的唯一构造点（BUG-001「错误落点唯一化」不变量）。
 *
 * 失败信息必须如实且只展示一次，因此按「本次 run 是否已产生残留文本」两态处理：
 * - 有残留文本（流式输出到一半失败）：正文保留残留文本，结构化错误只经气泡 error-block
 *   渲染。不把格式化错误拼进正文——否则「半截回答 + 错误」会混成一段无法复制的怪文本，
 *   且 error-block 会让同一句话连出两遍。
 * - 无残留文本（创建 / 传输即失败，live 事件为空）：正文直接承载格式化错误，
 *   同时把 error 置为 undefined，避免气泡里同一错误在正文与 error-block 重复展示。
 *
 * 该函数只返回需要 patch 的字段，调用方仍需保留 retryContext 等未触及字段
 * （Workbench 的 replaceMessage 按字段合并）。
 *
 * @param error 结构化 API 错误（run_error / snapshot.error）。
 * @param blocks 本次 run 已投影出的内容块（失败时通常为空或仅残留）。
 * @param cancelled 是否用户主动取消（取消时状态为 cancelled 且不弹 composer 提示）。
 * @returns UiMessage 失败态补丁。
 */
export function applyFailure(
  error: ApiError,
  blocks: UiContentBlock[],
  cancelled: boolean
): Pick<UiMessage, "content" | "blocks" | "status" | "ok" | "runStatus" | "error" | "liveEvents"> {
  const residualText = textOfBlocks(blocks);
  const hasResidualText = residualText.trim().length > 0;
  const status = cancelled ? "cancelled" : "failed";

  return {
    content: hasResidualText ? residualText : formatApiError(error),
    blocks,
    status,
    ok: false,
    runStatus: status,
    error: hasResidualText ? error : undefined,
    liveEvents: undefined
  };
}

/**
 * 生成浏览器本地 id，避免依赖服务端持久化能力。
 *
 * @param prefix id 前缀。
 * @returns UI id。
 */
export function createUiId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
