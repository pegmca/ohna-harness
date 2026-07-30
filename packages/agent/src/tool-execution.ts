/**
 * 工具批执行：对齐 pi agent-loop.ts 的 executeToolCalls 语义。
 *
 * 核心规则：
 * - 默认 parallel；批内任一工具 executionMode === "sequential"（或 config 全局 sequential）
 *   整批降级串行；
 * - stopReason === "length" 整批拒执：输出被 token 上限截断时，流式参数经 salvage 解析
 *   可能「能 parse 但 silently 不完整」，一个都不执行，逐个回喂错误让模型重发；
 * - 错误即数据：工具未找到、zod 校验失败、beforeToolCall block、执行抛异常，
 *   全部转成 isError: true 的 ToolResultMessage 回喂模型，loop 本身不抛错中断；
 * - parallel 模式先按序 prepare（找工具 → prepareArguments → zod 校验 → beforeToolCall），
 *   再并发执行，最后按 assistant 源顺序回喂 ToolResultMessage。
 */
import type { AssistantMessage, ToolResultMessage } from "@aiagent/ai";
import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentToolCall } from "./types.js";

/** loop 内部事件出口（agent-loop.ts 注入）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 一批工具调用的执行产物。 */
export interface ExecutedToolCallBatch {
  messages: ToolResultMessage[];
  /** 批内全部结果 terminate === true 时为 true，loop 据此提前结束 run。 */
  terminate: boolean;
}

/** 已完成 prepare、可以执行的工具调用。 */
type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
};

/** prepare 阶段即定局的调用（未找到/校验失败/block/abort），不进入执行。 */
type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult;
  isError: boolean;
};

type FinalizedToolCallOutcome = {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 整批拒执被 token 上限截断的 assistant 消息携带的工具调用。
 * 截断消息的参数可能 silently 不完整，任何执行都不安全（金融场景错误参数代价高于一次重试）。
 *
 * @param toolCalls 被截断消息中的 toolCall 块。
 * @param emit 事件出口。
 * @returns 全部为 isError 的 ToolResultMessage 批。
 */
export async function failToolCallsFromTruncatedMessage(
  toolCalls: AgentToolCall[],
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
    const finalized: FinalizedToolCallOutcome = {
      toolCall,
      result: createErrorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }
  return { messages, terminate: false };
}

/**
 * 执行一条 assistant 消息中的全部工具调用；按工具声明降级 sequential/parallel。
 *
 * @param currentContext 当前 agent 上下文（从中找工具实现）。
 * @param assistantMessage 发起工具调用的 assistant 消息。
 * @param config loop 配置（toolExecution / beforeToolCall / afterToolCall）。
 * @param signal run 级 AbortSignal。
 * @param emit 事件出口。
 * @returns 按 assistant 源顺序排列的 ToolResultMessage 批。
 */
export async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
  }
  return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 串行批执行：每个调用 prepare → execute → finalize 完成后才处理下一个。
 */
async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = { toolCall, result: preparation.result, isError: preparation.isError };
    } else {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (signal?.aborted) {
      break;
    }
  }

  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

/**
 * 并行批执行：先按序 prepare，再并发执行（tool_execution_end 按完成序发出），
 * 最后按 assistant 源顺序回喂 ToolResultMessage。
 */
async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      const finalized = { toolCall, result: preparation.result, isError: preparation.isError } satisfies FinalizedToolCallOutcome;
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted) {
        break;
      }
      continue;
    }

    finalizedCalls.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted) {
      break;
    }
  }

  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return { messages, terminate: shouldTerminateToolBatch(orderedFinalizedCalls) };
}

/** 批内全部结果 terminate === true 才提前结束 run（对齐 pi）。 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

/** 应用工具的 prepareArguments 兼容 shim（zod 校验前）。 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return { ...toolCall, arguments: preparedArguments as Record<string, unknown> };
}

/**
 * prepare 单个工具调用：找工具 → prepareArguments → zod 校验 → beforeToolCall。
 * 任何失败都转成 immediate 错误结果（错误即数据），不抛异常。
 */
async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
  }

  try {
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    // 与 pi 的差异点：pi 用 pi-ai 的 validateToolArguments（typebox），这里用 zod 校验。
    const parsed = tool.parameters.safeParse(preparedToolCall.arguments);
    if (!parsed.success) {
      return {
        kind: "immediate",
        result: createErrorToolResult(
          `Invalid arguments for tool ${toolCall.name}: ${(parsed.error.issues as { message: string }[]).map((issue) => issue.message).join("; ")}`,
        ),
        isError: true,
      };
    }
    const validatedArgs = parsed.data as unknown;

    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        { assistantMessage, toolCall, args: validatedArgs, context: currentContext },
        signal,
      );
      if (signal?.aborted) {
        return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
      }
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true,
        };
      }
    }
    if (signal?.aborted) {
      return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
    }
    return { kind: "prepared", toolCall, tool, args: validatedArgs };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

/** 执行已 prepare 的工具调用；执行抛异常转成 isError 结果（错误即数据）。 */
async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
      if (!acceptingUpdates) return;
      updateEvents.push(
        Promise.resolve(
          emit({
            type: "tool_execution_update",
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            args: prepared.toolCall.arguments,
            partialResult,
          }),
        ),
      );
    });
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

/** 应用 afterToolCall 逐字段覆盖；钩子抛异常同样转成 isError 结果。 */
async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        { assistantMessage, toolCall: prepared.toolCall, args: prepared.args, result, isError, context: currentContext },
        signal,
      );
      if (afterResult) {
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          usage: afterResult.usage ?? result.usage,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}

/** 统一构造错误工具结果（content 为错误文本，回喂模型自我修正）。 */
function createErrorToolResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], details: {} };
}

/** 发 tool_execution_end 事件。 */
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

/** 把 finalize 结果组装成 ToolResultMessage（details 不进 LLM 上下文，仅 trace/UI）。 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

/** 工具结果消息也走 message_start/message_end 事件，供 run 层落库。 */
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}
