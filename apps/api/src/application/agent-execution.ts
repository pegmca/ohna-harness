/**
 * Run 层的 agent loop 执行器：组装 AgentContext、调用 agentLoop、把 AgentEvent
 * 映射为现有 trace 事件流（request_received / model_call / tool_call /
 * report_skill_activation / report_plan / final_response），并汇总出 Run result 所需的
 * answer/intent/steps/reportPlan。
 *
 * 工具选择完全交给模型 function calling（无规则路由）；MockModel 与真实 provider
 * 走同一条路径，差异仅在注入的 streamFn。
 */
import {
  agentLoop,
  createReportActivation,
  createReportPlan,
  defaultConvertToLlm,
  isNaturalLanguageReportRequest,
  type AgentContext,
  type AgentEvent,
  type AgentLoopError,
  type AgentMessage,
  type AgentTool,
} from "@aiagent/agent";
import type { AssistantMessage } from "@aiagent/ai";
import type {
  AgentIntentDto,
  AgentStepDto,
  CitationDto,
  ReportPlanDto,
} from "@aiagent/types";
import type { ObservableTraceRecorder } from "@aiagent/trace";
import type { ModelRuntime } from "./model-registry.js";

/** 单 run 的最大 turn 数预算，防止真实模型陷入工具循环；对齐旧 DEFAULT_MAX_STEPS 的保护语义。 */
export const DEFAULT_MAX_TURNS = 8;

/** 基础 system prompt；附件 grounding 由 run-service 拼接在其后。 */
export const BASE_SYSTEM_PROMPT =
  "你是一个金融研究 Agent。可以自主调用提供的工具（财务指标、公告检索、计算器等）完成多步研究，"
  + "拿到工具结果后用中文给出简洁、有依据的回答。报告类诉求由系统在 run 层编排，无需自行生成完整研报。";

export interface AgentExecutionInput {
  message: string;
  /** report 按钮/toggle 显式触发；natural language 由本执行器自行判定。 */
  reportMode: boolean;
  reportTriggerSource?: "button" | "toggle";
  groundingContext?: string;
  groundingCitations?: CitationDto[];
  /** 会话历史快照（只读输入；loop 保持纯函数形态不就地修改，新消息经返回值回传）。 */
  history: AgentMessage[];
  runtime: ModelRuntime;
  tools: AgentTool[];
  signal: AbortSignal;
  trace: ObservableTraceRecorder;
  maxTurns?: number;
  now?: () => Date;
}

export interface AgentExecutionResult {
  ok: boolean;
  intent: AgentIntentDto;
  answer: string;
  citations?: CitationDto[];
  steps: AgentStepDto[];
  reportPlan?: ReportPlanDto;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  /** 本次 run 新产生的全部消息（含 prompt），由 run-service 追加进会话历史。 */
  newMessages: AgentMessage[];
}

/**
 * 执行一次完整 agent run：跑 loop、映射 trace、按需编排 report plan。
 *
 * @param input 执行输入（含会话历史与模型 runtime）。
 * @returns Run result 组装所需的结构化结果。
 */
export async function executeAgentLoop(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const now = input.now ?? (() => new Date());
  const systemPrompt = input.groundingContext
    ? `${BASE_SYSTEM_PROMPT}\n\n[附件检索证据]\n${input.groundingContext}`
    : BASE_SYSTEM_PROMPT;
  const context: AgentContext = {
    systemPrompt,
    messages: input.history,
    tools: input.tools,
  };
  const prompt: AgentMessage = { role: "user", content: input.message, timestamp: now().getTime() };

  input.trace.record({
    type: "request_received",
    id: `${input.trace.traceId}_request`,
    traceId: input.trace.traceId,
    requestId: input.trace.requestId,
    userMessage: input.message,
    inputPreview: input.message.slice(0, 200),
    createdAt: now().toISOString(),
  });

  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  // maxTurns 预算触顶标记：shouldStopAfterTurn 命中时置位，用于区分「正常收尾」与「预算耗尽」。
  let turnBudgetExceeded = false;
  const stream = agentLoop(
    [prompt],
    context,
    {
      model: input.runtime.model,
      apiKey: input.runtime.apiKey,
      convertToLlm: defaultConvertToLlm,
      // maxTurns 预算：统计已完成的 assistant 消息数，超预算优雅停止（替代旧 ensureStepBudget）。
      shouldStopAfterTurn: ({ newMessages }) => {
        if (newMessages.filter((message) => message.role === "assistant").length >= maxTurns) {
          turnBudgetExceeded = true;
          return true;
        }
        return false;
      },
    },
    input.signal,
    input.runtime.streamFn,
  );

  // 主流程顺序消费事件流并转写 trace；agent_end 是终止事件，携带本次 run 新消息。
  // 注意：trace 可能是 paced 包装（延迟落底层 recorder），intent/steps 统计必须本地累积，不能回读 getEvents()。
  const consumed = await consumeAgentEvents(stream, input.trace, now);

  const lastAssistant = findLastAssistant(consumed.newMessages);
  const aborted = input.signal.aborted || lastAssistant?.stopReason === "aborted";
  const failed = !aborted && lastAssistant?.stopReason === "error";
  // loop 兜底收尾（钩子抛错）：agent_end.error 携带结构化错误，不再当成功处理。
  const loopFailed = !aborted && !failed && consumed.loopError !== undefined;
  // 预算耗尽且最后一轮仍想继续调工具（stopReason 非 stop）：回答不完整，报 turn_budget_exceeded。
  const budgetExceeded =
    !aborted && !failed && !loopFailed && turnBudgetExceeded && lastAssistant?.stopReason !== "stop";
  const failedKind = aborted
    ? ("aborted" as const)
    : failed
      ? ("model" as const)
      : loopFailed
        ? ("loop" as const)
        : budgetExceeded
          ? ("budget" as const)
          : undefined;

  // report 编排保留在 run 层：显式 mode 或自然语言诉求都生成 plan（03 文档：report 由 run 层引导）。
  const reportPlan = failedKind ? undefined : maybeCreateReportPlan(input);
  const intent: AgentIntentDto = reportPlan ? "report_skill" : consumed.toolCallCount > 0 ? "tool" : "chat";
  const answer = aborted
    ? ""
    : budgetExceeded
      ? "已达到本次研究的最大分析轮数，回答可能不完整，请缩小问题范围后重试。"
      : lastAssistant
        ? extractAssistantText(lastAssistant)
        : "Agent 未能生成回答。";
  const executionError = aborted
    ? { code: "request_cancelled", message: "Agent run 已取消。" }
    : failed
      ? { code: "model_error", message: lastAssistant?.errorMessage ?? "模型调用失败。" }
      : loopFailed
        ? { code: consumed.loopError?.code ?? "agent_loop_aborted", message: consumed.loopError?.message ?? "Agent loop 异常终止。" }
        : budgetExceeded
          ? { code: "turn_budget_exceeded", message: "已达最大分析轮数预算，run 提前结束。" }
          : undefined;

  input.trace.record({
    type: "final_response",
    id: `${input.trace.traceId}_final`,
    traceId: input.trace.traceId,
    requestId: input.trace.requestId,
    answerPreview: answer.slice(0, 200),
    ok: !failedKind,
    error: executionError
      ? { code: executionError.code, message: executionError.message, stage: "agent_loop" }
      : undefined,
    createdAt: now().toISOString(),
  });

  return {
    ok: !failedKind,
    intent,
    answer,
    citations: input.groundingCitations,
    steps: consumed.steps,
    reportPlan,
    error: executionError,
    newMessages: consumed.newMessages,
  };
}

/**
 * 顺序消费 AgentEvent 流并转写为 trace 事件，返回 agent_end 携带的本次 run 新消息。
 * 顺序消费保证 final_response 之前所有 model_call/tool_call 已落 trace（无竞态）。
 * steps/toolCallCount 在本地累积：trace 可能被 paced 包装延迟落底层 recorder，回读 getEvents() 会漏。
 *
 * @param stream agentLoop 返回的事件流。
 * @param trace 当前 run 的 trace recorder。
 * @param now 时钟。
 * @returns 本次 run 新消息、工具调用计数、步骤 DTO 与 loop 兜底错误（正常结束为 undefined）。
 */
async function consumeAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  trace: ObservableTraceRecorder,
  now: () => Date,
): Promise<{ newMessages: AgentMessage[]; toolCallCount: number; steps: AgentStepDto[]; loopError?: AgentLoopError }> {
  let turnStartedAt = now().getTime();
  let turnIndex = 0;
  let newMessages: AgentMessage[] = [];
  let toolCallCount = 0;
  let loopError: AgentLoopError | undefined;
  const steps: AgentStepDto[] = [];
  const toolStarts = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>();
  for await (const event of stream) {
    switch (event.type) {
      case "agent_end":
        newMessages = event.messages;
        loopError = event.error;
        break;
      case "turn_start":
        turnIndex += 1;
        turnStartedAt = now().getTime();
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          const assistant = event.message;
          const durationMs = Math.max(0, now().getTime() - turnStartedAt);
          const ok = assistant.stopReason !== "error" && assistant.stopReason !== "aborted";
          trace.record({
            type: "model_call",
            id: `${trace.traceId}_model_${turnIndex}`,
            traceId: trace.traceId,
            requestId: trace.requestId,
            model: assistant.model,
            purpose: "agent_turn",
            durationMs,
            ok,
            usage: {
              promptTokens: assistant.usage.input,
              completionTokens: assistant.usage.output,
              totalTokens: assistant.usage.totalTokens,
            },
            error: assistant.errorMessage
              ? { code: "model_error", message: assistant.errorMessage, stage: "agent_loop" }
              : undefined,
            createdAt: now().toISOString(),
          });
          steps.push({
            index: steps.length,
            type: "model_call",
            status: ok ? "succeeded" : "failed",
            durationMs,
            data: { model: assistant.model },
            error: assistant.errorMessage
              ? { code: "agent_failed", message: assistant.errorMessage, details: { agentCode: "model_error" } }
              : undefined,
          });
        }
        break;
      case "tool_execution_start":
        toolStarts.set(event.toolCallId, {
          toolName: event.toolName,
          args: (event.args ?? {}) as Record<string, unknown>,
          startedAt: now().getTime(),
        });
        break;
      case "tool_execution_end": {
        const started = toolStarts.get(event.toolCallId);
        const durationMs = started ? Math.max(0, now().getTime() - started.startedAt) : 0;
        toolCallCount += 1;
        trace.record({
          type: "tool_call",
          id: `${trace.traceId}_tool_${event.toolCallId}`,
          traceId: trace.traceId,
          requestId: trace.requestId,
          toolName: event.toolName,
          args: started?.args ?? {},
          result: event.result,
          durationMs,
          ok: !event.isError,
          error: event.isError
            ? { code: "tool_execution_failed", message: extractToolErrorText(event.result), stage: "tool_execution" }
            : undefined,
          createdAt: now().toISOString(),
        });
        steps.push({
          index: steps.length,
          type: "tool_call",
          status: event.isError ? "failed" : "succeeded",
          durationMs,
          data: { toolName: event.toolName },
          error: event.isError
            ? { code: "agent_failed", message: extractToolErrorText(event.result), details: { agentCode: "tool_execution_failed" } }
            : undefined,
        });
        toolStarts.delete(event.toolCallId);
        break;
      }
      default:
        break;
    }
  }
  return { newMessages, toolCallCount, steps, loopError };
}

/**
 * 判定并生成 report plan（显式 report mode 或自然语言研报诉求），同时写 activation/plan trace。
 *
 * @param input 执行输入。
 * @returns ready 状态的 ReportPlanDto；非研报诉求返回 undefined。
 */
function maybeCreateReportPlan(input: AgentExecutionInput): ReportPlanDto | undefined {
  const naturalLanguage = isNaturalLanguageReportRequest(input.message);
  if (!input.reportMode && !naturalLanguage) return undefined;
  const activation = createReportActivation({
    message: input.message,
    reportMode: input.reportMode,
    explicitTriggerSource: input.reportMode ? input.reportTriggerSource : undefined,
    routeReason: "pi loop：工具选择交给模型 function calling，report 由 run 层编排",
    matchedRules: naturalLanguage ? ["natural_language_report_request"] : [],
  });
  const now = input.now ?? (() => new Date());
  input.trace.record({
    type: "report_skill_activation",
    id: `${input.trace.traceId}_report_activation`,
    traceId: input.trace.traceId,
    requestId: input.trace.requestId,
    triggerSource: activation.triggerSource,
    routeReason: activation.plannerInput.routeReason,
    matchedRules: activation.plannerInput.matchedRules,
    plannerInput: activation.plannerInput,
    createdAt: now().toISOString(),
  });
  const plan = createReportPlan(activation.plannerInput);
  input.trace.record({
    type: "report_plan",
    id: `${input.trace.traceId}_report_plan`,
    traceId: input.trace.traceId,
    requestId: input.trace.requestId,
    plan,
    assumptions: plan.assumptions,
    ok: plan.status === "ready",
    createdAt: now().toISOString(),
  });
  return plan.status === "ready" ? plan : undefined;
}

/**
 * 从新消息中取最后一条 assistant 消息。
 *
 * @param messages 本次 run 新产生的消息。
 * @returns 最后一条 assistant 消息或 undefined。
 */
function findLastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
}

/**
 * 拼接 assistant 消息的全部文本块作为面向用户的回答。
 *
 * @param message assistant 消息。
 * @returns 纯文本回答。
 */
function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * 从失败工具结果中提取可读错误文本。
 *
 * @param result 工具执行结果。
 * @returns 错误文本。
 */
function extractToolErrorText(result: unknown): string {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return "工具执行失败。";
}
