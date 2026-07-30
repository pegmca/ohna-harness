/**
 * 多轮 ReAct agent loop：对齐 pi（badlogic/packages/agent/src/agent-loop.ts）的纯函数实现。
 *
 * 结构：
 * - agentLoop / agentLoopContinue 是外壳：创建 EventStream，异步跑 runLoop；
 * - runLoop 是双层循环——内层 turn 循环（steering 注入 → streamAssistantResponse →
 *   收集 toolCall → executeToolCalls → ToolResultMessage 回喂 → prepareNextTurn /
 *   shouldStopAfterTurn），外层 follow-up 检查；
 * - AgentMessage 级变换（transformContext）与 LLM 消息转换（convertToLlm）只发生在
 *   streamAssistantResponse 的 LLM 调用边界。
 *
 * 与 pi 的差异：工具执行拆到 tool-execution.ts（单文件行数约束）；zod 校验替代
 * typebox validateToolArguments；默认 streamFn 是 @aiagent/ai 的 streamSimple。
 */
import { type AssistantMessage, type Context, EventStream, streamSimple } from "@aiagent/ai";
import { toLlmTools } from "./convert.js";
import {
  type AgentEventSink,
  executeToolCalls,
  failToolCallsFromTruncatedMessage,
} from "./tool-execution.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopError,
  AgentMessage,
  StreamFn,
} from "./types.js";
import type { ToolResultMessage } from "@aiagent/ai";

export { executeToolCalls, failToolCallsFromTruncatedMessage } from "./tool-execution.js";
export type { AgentEventSink } from "./tool-execution.js";

/**
 * 以一条/多条新 prompt 启动 agent loop。prompt 追加进 context.messages 并发出事件；
 * 返回 EventStream，最终结果（本次 run 新产生的全部消息）通过 stream.result() 获取。
 *
 * @param prompts 新追加的用户消息。
 * @param context 当前 agent 上下文（loop 会直接向其中 push 消息）。
 * @param config loop 配置（钩子见 types.ts）。
 * @param signal run 级 AbortSignal，贯穿 streamFn、工具执行与全部钩子。
 * @param streamFn LLM 流式函数，缺省用 @aiagent/ai 的 streamSimple；测试注入 mock。
 * @returns AgentEvent 事件流，终止事件 agent_end 携带新消息列表。
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(prompts, context, config, async (event) => {
    stream.push(event);
  }, signal, streamFn).then(
    (messages) => stream.end(messages),
    // 钩子违反「不得抛错」契约时也要收尾事件流：补发携带结构化错误的 agent_end
    // （不静默 stream.end，调用方靠 agent_end.error 区分正常结束与兜底结束）。
    (caught) => stream.push({
      type: "agent_end",
      messages: context.messages.slice(),
      error: toAgentLoopError(caught),
    }),
  );

  return stream;
}

/**
 * 不追加新消息，从当前上下文继续跑（用于重试/续跑，如 context overflow 压缩后重试）。
 * 前置校验：context 非空且最后一条消息不是 assistant（否则 provider 会拒绝请求）。
 * 最后一条消息能否转 user/toolResult 由 convertToLlm 决定，这里无法校验。
 *
 * @param context 当前 agent 上下文。
 * @param config loop 配置。
 * @param signal run 级 AbortSignal。
 * @param streamFn LLM 流式函数。
 * @returns AgentEvent 事件流。
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  const lastMessage = context.messages[context.messages.length - 1];
  if (lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(context, config, async (event) => {
    stream.push(event);
  }, signal, streamFn).then(
    (messages) => stream.end(messages),
    (caught) => stream.push({
      type: "agent_end",
      messages: [],
      error: toAgentLoopError(caught),
    }),
  );

  return stream;
}

/**
 * agentLoop 的异步主体：追加 prompt、发 agent_start/turn_start 与 prompt 消息事件后进入 runLoop。
 *
 * @returns 本次 run 新产生的全部消息（含 prompt）。
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? streamSimple);
  return newMessages;
}

/**
 * agentLoopContinue 的异步主体：不追加消息，直接进入 runLoop。
 *
 * @returns 本次续跑新产生的消息。
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? streamSimple);
  return newMessages;
}

/** 创建 agent_end 为终止事件的 EventStream。 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

/**
 * 把钩子抛出的异常收敛为结构化 loop 错误，避免原始异常对象进入事件流。
 *
 * @param caught runAgentLoop reject 的原始值。
 * @returns 结构化 AgentLoopError。
 */
function toAgentLoopError(caught: unknown): AgentLoopError {
  return {
    code: "agent_loop_aborted",
    message: caught instanceof Error ? caught.message : "Agent loop aborted unexpectedly.",
  };
}

/**
 * 主循环（agentLoop / agentLoopContinue 共享）。
 * 内层处理 toolCall 与 steering；内层退出后外层查 follow-up，有则继续，否则 agent_end。
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  // 开局先查一次 steering（用户可能在等待期间输入了新消息）。
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // 外层循环：agent 本可停止时，有排队 follow-up 消息则继续跑。
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环：处理 toolCall 与 steering 消息。
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // 在下一次 assistant 响应前注入排队消息。
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter((c) => c.type === "toolCall");

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        // stopReason "length" 表示输出被 token 上限截断：整批拒执，回喂错误让模型重发。
        const executedToolBatch =
          message.stopReason === "length"
            ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
            : await executeToolCalls(currentContext, message, config, signal, emit);
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      const nextTurnContext = { message, toolResults, context: currentContext, newMessages };
      const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
      if (nextTurnSnapshot) {
        currentContext = nextTurnSnapshot.context ?? currentContext;
        config = {
          ...config,
          model: nextTurnSnapshot.model ?? config.model,
          reasoning:
            nextTurnSnapshot.thinkingLevel === undefined
              ? config.reasoning
              : nextTurnSnapshot.thinkingLevel === "off"
                ? undefined
                : nextTurnSnapshot.thinkingLevel,
        };
      }

      if (await config.shouldStopAfterTurn?.({ message, toolResults, context: currentContext, newMessages })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // agent 本可停止：查 follow-up 队列。
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 调一次 LLM 并流式转发事件。AgentMessage[] → Message[] 的转换只发生在这里：
 * 先 transformContext（AgentMessage 级变换），再 convertToLlm，组装 Context 后调 streamFn；
 * 逐事件把 partial message 写回 context.messages 尾部并转发 message_start/update/end。
 *
 * @returns 最终的 AssistantMessage（stopReason 为 error/aborted 时由 runLoop 收尾）。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<AssistantMessage> {
  // AgentMessage 级上下文变换（裁剪/注入/compaction）。
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const llmMessages = await config.convertToLlm(messages);

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools ? toLlmTools(context.tools) : undefined,
  };

  // 每次调用动态解析 key（短寿命 token 场景）。
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  // 流意外结束（无 done/error）时兜底取 result，保证 loop 不悬挂。
  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}
