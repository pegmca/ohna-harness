/**
 * 测试替身模型（test double），仅用于离线集成测试，非生产 mock 模式。
 *
 * 本项目已在 v1.2 去 mock 化改造中删除运行时 MockModel（apps/finance-api/src/adapters/mock-model.ts），
 * 生产 composition root 只支持真实 provider。本文件是测试专用的「替身」，复刻了原 MockModel 的
 * 确定性 StreamFn 行为（按上下文选择工具调用 / 汇总工具结果），但：
 *   - 从不发起任何外部 HTTP 请求；
 *   - provider 标识为 "test-double"，与已移除的运行时 mock 明确区分；
 *   - 仅由 createInMemoryApiTestRuntime 与根目录冒烟脚本在离线场景下注入。
 *
 * 它与真实 provider 走完全相同的 agentLoop 代码路径（StreamFn 边界不变），
 * 因此集成测试在无真实 key 时也能跑通，且断言的是「测试替身应有的确定性行为」。
 */
import { createAssistantMessageEventStream } from "@aiagent/ai";
import type {
  AssistantMessage,
  Message,
  Model,
  StopReason,
  TextContent,
  ToolCall
} from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";
import { createModelRuntimeRegistry } from "../application/model-registry.js";

/** 测试替身的 pi 目录条目；api 仅作占位，streamFn 注入后不会真正发起 HTTP 请求。
 * provider 复用目录既有的 "mock" 字面（测试替身约定，与已移除的运行时 MockModel 区分靠本模块与 id），id 取 "test-double" 以示区别。 */
export const TEST_DOUBLE_MODEL: Model<"openai-completions"> = {
  id: "test-double",
  name: "Test Double Agent",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost/test-double",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096
};

/** 零用量统计，避免替身产生计费信号。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

/**
 * 创建满足 StreamFn 契约的测试替身流式函数：同步产出完整事件序列，从不抛错。
 * 与原 MockModel 行为一致，但 provider 标识为 test-double。
 *
 * @returns 测试替身 streamFn。
 */
export function createTestDoubleStreamFn(): StreamFn {
  return (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const message = decideTestDoubleMessage(
      context.messages,
      new Set((context.tools ?? []).map((tool) => tool.name))
    );
    const partial: AssistantMessage = { ...message, content: [] };
    stream.push({ type: "start", partial });
    message.content.forEach((block, contentIndex) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message
    });
    return stream;
  };
}

/**
 * 按上下文最后一条消息决定本轮测试替身输出：toolResult 之后收尾，否则按用户文本选工具。
 * 行为与原 MockModel 一致，仅文本前缀改为「测试替身」以明确身份。
 *
 * @param messages 当前 LLM 上下文消息。
 * @param availableTools 本轮可用工具名集合（MCP 工具在装配期并入后优先于同名 mock 工具）。
 * @returns 完整的测试替身 AssistantMessage。
 */
function decideTestDoubleMessage(messages: Message[], availableTools: Set<string>): AssistantMessage {
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const toolResults = messages.filter(
      (message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult"
    );
    const hasError = toolResults.some((message) => message.isError);
    const summary = toolResults
      .map((message) =>
        message.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join(" ")
      )
      .join("\n");
    return createMessage(
      [{
        type: "text",
        text: hasError
          ? `（测试替身）工具执行失败，无法完成回答：\n${summary}`
          : `（测试替身）已基于工具结果完成回答：\n${summary}`
      }],
      "stop"
    );
  }
  const userText = extractLastUserText(messages);
  const toolCall = decideToolCall(userText, availableTools);
  if (toolCall) {
    return createMessage([toolCall], "toolUse");
  }
  return createMessage(
    [{ type: "text", text: "（测试替身固定回答）本地离线集成测试，这是确定性替身输出，不发起任何外部请求。" }],
    "stop"
  );
}

/**
 * 按用户文本决定一次确定性 toolCall；返回 undefined 表示直接文本回答。
 * 工具名与判定规则与原 MockModel 保持一致，确保既有集成测试断言稳定。
 *
 * @param text 最后一条用户消息文本。
 * @param availableTools 本轮可用工具名集合。
 * @returns toolCall 内容块或 undefined。
 */
function decideToolCall(text: string, availableTools: Set<string>): ToolCall | undefined {
  const expression = text
    .match(/\d+(?:\.\d+)?(?:\s*[-+*/×÷]\s*\d+(?:\.\d+)?)+/u)?.[0]
    ?.replace(/[×÷]/gu, (char) => (char === "×" ? "*" : "/"));
  if (expression) {
    return {
      type: "toolCall",
      id: `test_double_call_${Date.now().toString(36)}`,
      name: "calculator",
      arguments: { expression }
    };
  }
  const ticker = text.match(/\b\d{6}\.(?:SZ|SH|BJ)\b/iu)?.[0]?.toUpperCase();
  // 研报 / 研究简报 / PDF 生成意图优先于检索与单指标查询。
  if (/研报|研究报告|深度报告|研究简报|PDF/iu.test(text)) {
    return {
      type: "toolCall",
      id: `test_double_call_${Date.now().toString(36)}`,
      name: "generate_report",
      arguments: {
        subject: ticker ?? extractReportSubject(text),
        scope: text.match(/最近两年|近两年|最近一年|近一年|最近一期|20\d{2}/u)?.[0]
      }
    };
  }
  if (ticker || /净利润|ROE|营收|财务指标/iu.test(text)) {
    return {
      type: "toolCall",
      id: `test_double_call_${Date.now().toString(36)}`,
      name: "financial_metric_mock",
      arguments: { ticker: ticker ?? "000001.SZ", metrics: ["net_profit", "roe"] }
    };
  }
  if (/公告|年报|检索/iu.test(text)) {
    // MCP 装配优先：discovery 产出并入工具集后，同一检索意图走真实 MCP server。
    if (availableTools.has("search_filings")) {
      return {
        type: "toolCall",
        id: `test_double_call_${Date.now().toString(36)}`,
        name: "search_filings",
        arguments: { companyId: ticker ?? "000001.SZ", query: text.slice(0, 50), topK: 2 }
      };
    }
    return {
      type: "toolCall",
      id: `test_double_call_${Date.now().toString(36)}`,
      name: "filing_search_mock",
      arguments: { ticker: ticker ?? "000001.SZ", query: text.slice(0, 50) }
    };
  }
  return undefined;
}

/**
 * 无 ticker 时从文本截取研究对象短语（测试替身确定性兜底，保证冒烟链路稳定）。
 *
 * @param text 用户消息文本。
 * @returns 截取的研究对象短语。
 */
function extractReportSubject(text: string): string {
  const cleaned = text
    .replace(/帮我|请|生成|撰写|写一份|写|的|研报|研究报告|深度报告|一份/gu, "")
    .trim();
  return cleaned.slice(0, 24) || "通用研究对象";
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
  const content = lastUser.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join(" ")
      : "";
}

/**
 * 组装一条完整的测试替身 AssistantMessage。
 *
 * @param content 内容块（文本或工具调用）。
 * @param stopReason 停止原因。
 * @returns AssistantMessage。
 */
function createMessage(content: (TextContent | ToolCall)[], stopReason: StopReason): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: TEST_DOUBLE_MODEL.api,
    provider: TEST_DOUBLE_MODEL.provider,
    model: TEST_DOUBLE_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 创建测试替身运行时（model + streamFn），供 createInMemoryApiTestRuntime 注册进模型目录。
 *
 * @returns 可直接放进 ModelRuntimeEntry.runtime 的值。
 */
export function createTestDoubleModelRuntime() {
  return { model: TEST_DOUBLE_MODEL, streamFn: createTestDoubleStreamFn() };
}

/**
 * 创建只包含单个测试替身、且为默认模型的模型目录，供离线集成测试注入。
 *
 * @returns 仅含 test-double 的模型目录。
 */
export function createTestDoubleModelRegistry() {
  return createModelRuntimeRegistry(
    [{
      option: {
        id: "test-double",
        label: "Test Double",
        provider: "mock",
        description: "离线集成测试替身，不发起外部请求",
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true },
        // v2.0（docs/v2.0/04 §5.6）：模型目录新增成本计量字段；测试替身费率按 0 下发。
        contextWindow: TEST_DOUBLE_MODEL.contextWindow,
        maxTokens: TEST_DOUBLE_MODEL.maxTokens,
        cost: { ...TEST_DOUBLE_MODEL.cost }
      },
      runtime: createTestDoubleModelRuntime()
    }],
    "test-double"
  );
}
