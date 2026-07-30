/**
 * MockModel：无 API key 的本地确定性模型，实现 streamSimple 形状（StreamFn）注入 agentLoop，
 * 与真实 provider 走完全相同的 loop 代码路径（docs/worktree/03「intent-router 处置」的缓解措施）。
 *
 * 行为可预测：
 * - 上一轮有 toolResult → 汇总工具结果生成最终文本（stop）；
 * - 用户消息含算式 → calculator toolCall；
 * - 含 A 股 ticker 或财务指标关键词 → financial_metric_mock toolCall；
 * - 含公告/年报检索关键词 → filing_search_mock toolCall；
 * - 其他 → 固定说明文本（stop）。
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type Usage,
} from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";
import type { ModelRuntime } from "../application/model-registry.js";

/** Mock 模型的 pi 目录条目；api 仅作占位，streamFn 注入后不会真正发起 HTTP 请求。 */
export const MOCK_MODEL: Model<"openai-completions"> = {
  id: "mock",
  name: "Mock Agent",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 创建 MockModel 运行时（model + streamFn），供 composition root 注册进模型目录。
 *
 * @returns 可直接放进 ModelRuntimeEntry.runtime 的值。
 */
export function createMockModelRuntime(): ModelRuntime {
  return { model: MOCK_MODEL, streamFn: createMockStreamFn() };
}

/**
 * 创建满足 StreamFn 契约的 Mock 流式函数：同步产出完整事件序列，从不抛错。
 *
 * @returns Mock streamFn。
 */
export function createMockStreamFn(): StreamFn {
  return (_model: Model<Api>, context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const message = decideMockMessage(context.messages);
    // 事件序列对齐真实 provider：start → 内容增量 → done。
    const partial: AssistantMessage = { ...message, content: [] };
    stream.push({ type: "start", partial });
    for (const block of message.content) {
      const contentIndex = message.content.indexOf(block);
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
}

/**
 * 按上下文最后一条消息决定本轮 Mock 输出：toolResult 之后收尾，否则按用户文本选工具。
 *
 * @param messages 当前 LLM 上下文消息。
 * @returns 完整的 Mock AssistantMessage。
 */
function decideMockMessage(messages: Message[]): AssistantMessage {
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const toolResults = messages.filter((message) => message.role === "toolResult");
    // 任一工具失败时输出失败口吻，不再伪装成「已基于工具结果完成回答」。
    const hasError = toolResults.some((message) => message.role === "toolResult" && message.isError);
    const summary = toolResults
      .map((message) =>
        message.role === "toolResult"
          ? `${message.toolName}: ${message.content
              .filter((block) => block.type === "text")
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(" ")}`
          : "")
      .join("\n");
    return createMessage(
      [{
        type: "text",
        text: hasError
          ? `（MockModel）工具执行失败，无法完成回答：\n${summary}`
          : `（MockModel）已基于工具结果完成回答：\n${summary}`,
      }],
      "stop",
    );
  }

  const userText = extractLastUserText(messages);
  const toolCall = decideToolCall(userText);
  if (toolCall) {
    return createMessage([toolCall], "toolUse");
  }
  return createMessage(
    [{
      type: "text",
      text: "（MockModel 固定回答）本地未配置真实模型 API key，这是确定性 mock 输出。"
        + "配置 AIAGENT_PROVIDER_MODE=real 与对应 AIAGENT_LLM_* 环境变量后可切换真实模型。",
    }],
    "stop",
  );
}

/**
 * 按用户文本决定一次确定性 toolCall；返回 undefined 表示直接文本回答。
 *
 * @param text 最后一条用户消息文本。
 * @returns toolCall 内容块或 undefined。
 */
function decideToolCall(text: string): Extract<AssistantMessage["content"][number], { type: "toolCall" }> | undefined {
  const expression = text.match(/\d+(?:\.\d+)?(?:\s*[-+*/×÷]\s*\d+(?:\.\d+)?)+/)?.[0]?.replace(/[×÷]/g, (char) => (char === "×" ? "*" : "/"));
  if (expression) {
    return { type: "toolCall", id: `mock_call_${Date.now().toString(36)}`, name: "calculator", arguments: { expression } };
  }
  const ticker = text.match(/\b\d{6}\.(?:SZ|SH|BJ)\b/i)?.[0]?.toUpperCase();
  if (ticker || /净利润|ROE|营收|财务指标/.test(text)) {
    return {
      type: "toolCall",
      id: `mock_call_${Date.now().toString(36)}`,
      name: "financial_metric_mock",
      arguments: { ticker: ticker ?? "000001.SZ", metrics: ["net_profit", "roe"] },
    };
  }
  if (/公告|年报|检索/.test(text)) {
    return {
      type: "toolCall",
      id: `mock_call_${Date.now().toString(36)}`,
      name: "filing_search_mock",
      arguments: { ticker: ticker ?? "000001.SZ", query: text.slice(0, 50) },
    };
  }
  return undefined;
}

/**
 * 取最后一条用户消息的纯文本。
 *
 * @param messages 上下文消息。
 * @returns 用户文本；没有用户消息时为空串。
 */
function extractLastUserText(messages: Message[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser || lastUser.role !== "user") return "";
  return typeof lastUser.content === "string"
    ? lastUser.content
    : lastUser.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

/**
 * 组装一条完整的 Mock AssistantMessage。
 *
 * @param content 内容块。
 * @param stopReason 停止原因。
 * @returns AssistantMessage。
 */
function createMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MOCK_MODEL.api,
    provider: MOCK_MODEL.provider,
    model: MOCK_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}
