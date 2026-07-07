import { createDefaultToolRegistry } from "@aiagent/tools";
import { createInMemoryTraceRecorder, type TraceRecorder } from "@aiagent/trace";
import type { LlmClient, LlmError, ReportPlanDto } from "@aiagent/types";
import { createIntentRouter } from "./intent-router.js";
import { createReportActivation, createReportPlan } from "./report-planner.js";
import type {
  Agent,
  AgentConfig,
  AgentError,
  AgentIntent,
  AgentRequest,
  AgentResponse,
  AgentRoute,
  AgentRouter,
  AgentStep,
  AgentStepType
} from "./types.js";

const DEFAULT_MAX_STEPS = 6;

/**
 * 创建最小金融研究 Agent，封装 intent route、工具调用、轻量回答和 trace 写入。
 *
 * @param config 可注入模型、工具 registry、trace recorder 和测试 router。
 * @returns 可执行单次 run 的 Agent。
 */
export function createAgent(config: AgentConfig = {}): Agent {
  const toolRegistry = config.toolRegistry ?? createDefaultToolRegistry();
  const router =
    config.router ??
    createIntentRouter({
      llmClient: config.llmClient,
      enableModelRouter: config.enableModelRouter,
      traceRecorder: config.traceRecorder
    });

  return {
    run(request) {
      return runAgent(request, { ...config, toolRegistry, router });
    }
  };
}

/**
 * 执行一次 Agent Loop，所有业务失败都转成 AgentResponse，避免向 UI 泄漏原始异常。
 *
 * @param request 用户请求。
 * @param config Agent 依赖。
 * @returns 结构化 Agent 响应。
 */
export async function runAgent(request: AgentRequest, config: AgentConfig = {}): Promise<AgentResponse> {
  const toolRegistry = config.toolRegistry ?? createDefaultToolRegistry();
  const trace = config.traceRecorder ?? createInMemoryTraceRecorder();
  const router =
    config.router ??
    createIntentRouter({ llmClient: config.llmClient, enableModelRouter: config.enableModelRouter, traceRecorder: trace });
  const steps: AgentStep[] = [];
  const maxSteps = normalizeMaxSteps(request.maxSteps);
  const message = request.message.trim();

  recordTrace(trace, {
    type: "request_received",
    id: createTraceEventId(trace.traceId, "request"),
    traceId: trace.traceId,
    requestId: trace.requestId,
    userMessage: message,
    inputPreview: preview(message),
    createdAt: new Date().toISOString()
  });

  if (!message) {
    return finish(trace, steps, "chat", "请输入需要研究或解释的问题。", false, {
      code: "empty_message",
      message: "Message is required."
    });
  }

  const initialBudget = ensureStepBudget(steps, maxSteps, trace);

  if (initialBudget) {
    return finish(trace, steps, "chat", initialBudget.message, false, initialBudget);
  }

  let route: AgentRoute;

  try {
    route = await runStep(steps, trace, maxSteps, "route_intent", async () => {
      const routed =
        request.reportMode || request.reportTriggerSource === "button"
          ? {
              intent: "report_skill" as const,
              confidence: 1,
              reason:
                request.reportTriggerSource === "button"
                  ? "用户点击生成研报按钮，显式进入 report skill planner。"
                  : "Report Mode 开关已开启，显式进入 report skill planner。",
              matchedRules: [request.reportTriggerSource === "button" ? "report_button" : "report_mode_toggle"]
            }
          : await router.route(message);
      recordTrace(trace, {
        type: "intent_routed",
        id: createTraceEventId(trace.traceId, "intent"),
        traceId: trace.traceId,
        requestId: trace.requestId,
        intent: routed.intent,
        confidence: routed.confidence,
        reason: routed.reason,
        toolName: routed.tool?.toolName,
        createdAt: new Date().toISOString()
      });
      return {
        result: routed,
        data: {
          intent: routed.intent,
          confidence: routed.confidence,
          reason: routed.reason,
          matchedRules: routed.matchedRules,
          toolName: routed.tool?.toolName
        }
      };
    });
  } catch (error) {
    const agentError = toAgentError(error, "router_error", "意图识别失败，请稍后重试。");
    return finish(trace, steps, "chat", agentError.message, false, agentError);
  }

  const budgetAfterRoute = ensureStepBudget(steps, maxSteps, trace);

  if (budgetAfterRoute) {
    return finish(trace, steps, route.intent, budgetAfterRoute.message, false, budgetAfterRoute);
  }

  if (route.intent === "report_skill") {
    return runReportSkillPath(trace, steps, maxSteps, route, request);
  }

  if (route.intent === "tool") {
    return runToolPath(trace, steps, maxSteps, route, toolRegistry);
  }

  return runChatPath(trace, steps, maxSteps, route, message, config.llmClient);
}

/**
 * 执行 Report Skill activation 和 planner 路径，只生成计划，不启动完整 workflow。
 *
 * @param trace trace recorder。
 * @param steps Agent 步骤列表。
 * @param maxSteps 最大步骤数。
 * @param route 路由结果。
 * @param request Agent 请求。
 * @returns Agent 响应。
 */
async function runReportSkillPath(
  trace: TraceRecorder,
  steps: AgentStep[],
  maxSteps: number,
  route: AgentRoute,
  request: AgentRequest
): Promise<AgentResponse> {
  const budget = ensureStepBudget(steps, maxSteps, trace);

  if (budget) {
    return finish(trace, steps, route.intent, budget.message, false, budget);
  }

  const activation = await runStep(steps, trace, maxSteps, "report_skill_activation", async () => {
    const result = createReportActivation({
      message: request.message.trim(),
      reportMode: request.reportMode,
      explicitTriggerSource: request.reportTriggerSource,
      routeReason: route.reason,
      matchedRules: route.matchedRules
    });

    recordTrace(trace, {
      type: "report_skill_activation",
      id: createTraceEventId(trace.traceId, "report_activation"),
      traceId: trace.traceId,
      requestId: trace.requestId,
      triggerSource: result.triggerSource,
      routeReason: route.reason,
      matchedRules: route.matchedRules,
      plannerInput: result.plannerInput,
      createdAt: new Date().toISOString()
    });

    return {
      result,
      data: {
        triggerSource: result.triggerSource,
        plannerInput: result.plannerInput
      }
    };
  });

  const plan = await runStep(steps, trace, maxSteps, "report_skill_plan", async () => {
    const result = createReportPlan(activation.plannerInput);

    recordTrace(trace, {
      type: "report_plan",
      id: createTraceEventId(trace.traceId, "report_plan"),
      traceId: trace.traceId,
      requestId: trace.requestId,
      plan: result,
      assumptions: result.assumptions,
      ok: true,
      createdAt: new Date().toISOString()
    });

    return {
      result,
      data: {
        plan: result
      }
    };
  });
  const answer = formatReportPlanAnswer(plan);

  return finish(trace, steps, route.intent, answer, true, undefined, plan);
}

/**
 * 把 ReportPlanDto 压缩成 assistant 消息可读摘要，完整 plan 仍保留在 DTO 和 trace 中。
 *
 * @param plan Report planner 输出。
 * @returns 面向用户的计划摘要。
 */
function formatReportPlanAnswer(plan: ReportPlanDto): string {
  const subject = plan.subject ?? "待确认研究对象";
  const timeRange = plan.timeRange ?? "待确认时间范围";
  const questions =
    plan.clarificationQuestions.length > 0 ? `\n需要澄清：${plan.clarificationQuestions.join("；")}` : "";

  return [
    `已进入 Report Mode，并生成 ${plan.status} plan。`,
    `报告类型：${plan.reportType}；研究对象：${subject}；时间范围：${timeRange}。`,
    `数据需求：${plan.requiredData.join("、")}。`,
    `下一步：${plan.steps.map((step) => step.title).join(" -> ")}。${questions}`
  ].join("\n");
}

/**
 * 执行工具路径，工具选择和调用都作为独立步骤写入 trace。
 *
 * @param trace trace recorder。
 * @param steps Agent 步骤列表。
 * @param maxSteps 最大步骤数。
 * @param route 路由结果。
 * @param toolRegistry 工具 registry。
 * @returns Agent 响应。
 */
async function runToolPath(
  trace: TraceRecorder,
  steps: AgentStep[],
  maxSteps: number,
  route: AgentRoute,
  toolRegistry: NonNullable<AgentConfig["toolRegistry"]>
): Promise<AgentResponse> {
  const tool = route.tool;

  if (!tool) {
    const error: AgentError = {
      code: "router_error",
      message: "工具意图缺少工具选择结果。",
      details: { route }
    };
    return finish(trace, steps, route.intent, error.message, false, error);
  }

  const selectBudget = ensureStepBudget(steps, maxSteps, trace);

  if (selectBudget) {
    return finish(trace, steps, route.intent, selectBudget.message, false, selectBudget);
  }

  await runStep(steps, trace, maxSteps, "select_tool", async () => ({
    result: tool,
    data: {
      toolName: tool.toolName,
      args: tool.args,
      reason: tool.reason
    }
  }));

  const callBudget = ensureStepBudget(steps, maxSteps, trace);

  if (callBudget) {
    return finish(trace, steps, route.intent, callBudget.message, false, callBudget);
  }

  let toolResult: Awaited<ReturnType<typeof toolRegistry.execute>>;

  try {
    toolResult = await runStep(steps, trace, maxSteps, "call_tool", async () => {
      const result = await toolRegistry.execute(tool.toolName, tool.args, { trace });

      if (!result.ok) {
        throw {
          code: result.error.code,
          message: result.error.message,
          details: {
            toolName: result.toolName,
            toolError: result.error
          }
        } satisfies AgentError;
      }

      return {
        result,
        data: {
          toolName: result.toolName,
          args: result.args,
          result: result.result
        }
      };
    });
  } catch (error) {
    const agentError = toAgentError(error, "tool_error", "工具调用失败，请检查参数或稍后重试。");
    return finish(trace, steps, route.intent, agentError.message, false, agentError);
  }

  const answer = toolResult.ok
    ? formatToolAnswer(toolResult.toolName, toolResult.result)
    : "工具调用失败，请检查参数或稍后重试。";
  return finish(trace, steps, route.intent, answer, true);
}

/**
 * 执行轻量问答路径，有模型时调用模型，无模型时返回可预测的本地 mock 回答。
 *
 * @param trace trace recorder。
 * @param steps Agent 步骤列表。
 * @param maxSteps 最大步骤数。
 * @param route 路由结果。
 * @param message 用户输入。
 * @param llmClient 可选模型 client。
 * @returns Agent 响应。
 */
async function runChatPath(
  trace: TraceRecorder,
  steps: AgentStep[],
  maxSteps: number,
  route: AgentRoute,
  message: string,
  llmClient?: LlmClient
): Promise<AgentResponse> {
  const budget = ensureStepBudget(steps, maxSteps, trace);

  if (budget) {
    return finish(trace, steps, route.intent, budget.message, false, budget);
  }

  try {
    const answer = await runStep(steps, trace, maxSteps, "model_answer", async () => {
      const startedAt = performance.now();

      if (!llmClient) {
        return {
          result: mockChatAnswer(message),
          data: {
            model: "mock",
            source: "local_rule"
          }
        };
      }

      const result = await llmClient.chat({
        messages: [
          {
            role: "system",
            content: "你是金融研究助手。回答概念解释，不生成投资建议、评级或目标价。"
          },
          {
            role: "user",
            content: message
          }
        ],
        temperature: 0.2
      });
      const durationMs = elapsedMs(startedAt);

      recordTrace(trace, {
        type: "model_call",
        id: createTraceEventId(trace.traceId, "model"),
        traceId: trace.traceId,
        requestId: trace.requestId,
        model: result.ok ? result.data.model : "unknown",
        purpose: "chat_answer",
        durationMs,
        ok: result.ok,
        usage: result.ok ? result.data.usage : undefined,
        error: result.ok ? undefined : result.error,
        createdAt: new Date().toISOString()
      });

      if (!result.ok) {
        throw toModelAgentError(result.error);
      }

      return {
        result: result.data.content,
        data: {
          model: result.data.model,
          usage: result.data.usage
        }
      };
    });

    return finish(trace, steps, route.intent, answer, true);
  } catch (error) {
    const agentError = toAgentError(error, "model_error", "模型回答失败，请稍后重试。");
    return finish(trace, steps, route.intent, agentError.message, false, agentError);
  }
}

/**
 * 包装单个 Agent 步骤，统一记录 step 结果、耗时和结构化错误。
 *
 * @template TResult 步骤返回值类型。
 * @param steps Agent 步骤列表。
 * @param trace trace recorder。
 * @param maxSteps 最大步骤数。
 * @param type 步骤类型。
 * @param action 实际步骤逻辑。
 * @returns 步骤 action 返回值。
 */
async function runStep<TResult>(
  steps: AgentStep[],
  trace: TraceRecorder,
  maxSteps: number,
  type: AgentStepType,
  action: () => Promise<{ result: TResult; data?: Record<string, unknown> }>
): Promise<TResult> {
  const budget = ensureStepBudget(steps, maxSteps, trace);

  if (budget) {
    throw budget;
  }

  const startedAt = performance.now();
  const index = steps.length;

  try {
    const output = await action();
    pushStep(steps, trace, {
      index,
      type,
      status: "succeeded",
      durationMs: elapsedMs(startedAt),
      data: output.data
    });
    return output.result;
  } catch (error) {
    const agentError = toAgentError(error, "router_error", "Agent step failed.");
    pushStep(steps, trace, {
      index,
      type,
      status: "failed",
      durationMs: elapsedMs(startedAt),
      error: agentError
    });
    throw agentError;
  }
}

/**
 * 检查步骤预算，达到上限时追加 max_steps_exceeded 步骤并返回结构化错误。
 *
 * @param steps Agent 步骤列表。
 * @param maxSteps 最大步骤数。
 * @param trace trace recorder。
 * @returns 未超限时返回 undefined，超限时返回错误。
 */
function ensureStepBudget(steps: AgentStep[], maxSteps: number, trace: TraceRecorder): AgentError | undefined {
  if (steps.length < maxSteps) {
    return undefined;
  }

  const existing = steps.find((step) => step.type === "max_steps_exceeded");
  const error: AgentError = {
    code: "max_steps_exceeded",
    message: `Agent Loop 已达到 maxSteps=${maxSteps}，请提高步数上限后重试。`,
    details: {
      maxSteps,
      completedSteps: steps.length
    }
  };

  if (!existing) {
    pushStep(steps, trace, {
      index: steps.length,
      type: "max_steps_exceeded",
      status: "failed",
      durationMs: 0,
      error
    });
  }

  return error;
}

/**
 * 追加步骤并同步写入 trace agent_step 事件。
 *
 * @param steps Agent 步骤列表。
 * @param trace trace recorder。
 * @param step 新步骤。
 * @returns 已追加的步骤。
 */
function pushStep(steps: AgentStep[], trace: TraceRecorder, step: AgentStep): AgentStep {
  steps.push(step);
  recordTrace(trace, {
    type: "agent_step",
    id: createTraceEventId(trace.traceId, `step_${step.index}`),
    traceId: trace.traceId,
    requestId: trace.requestId,
    stepIndex: step.index,
    stepType: step.type,
    status: step.status === "succeeded" ? "succeeded" : "failed",
    durationMs: step.durationMs,
    data: step.data,
    error: step.error,
    createdAt: new Date().toISOString()
  });
  return step;
}

/**
 * 完成响应并写入 final_response trace；失败响应包含用户可理解的 answer 和结构化错误。
 *
 * @param trace trace recorder。
 * @param steps Agent 步骤列表。
 * @param intent 最终意图。
 * @param answer 面向用户的回答。
 * @param ok 是否成功。
 * @param error 可选结构化错误。
 * @param reportPlan 可选 Report planner 输出。
 * @returns Agent 响应。
 */
function finish(
  trace: TraceRecorder,
  steps: AgentStep[],
  intent: AgentIntent,
  answer: string,
  ok: boolean,
  error?: AgentError,
  reportPlan?: ReportPlanDto
): AgentResponse {
  if (steps.at(-1)?.type !== "final_response") {
    pushStep(steps, trace, {
      index: steps.length,
      type: "final_response",
      status: ok ? "succeeded" : "failed",
      durationMs: 0,
      data: {
        answerPreview: preview(answer),
        intent
      },
      error
    });
  }

  recordTrace(trace, {
    type: "final_response",
    id: createTraceEventId(trace.traceId, "final"),
    traceId: trace.traceId,
    requestId: trace.requestId,
    answerPreview: preview(answer),
    ok,
    error,
    createdAt: new Date().toISOString()
  });

  return {
    ok,
    intent,
    answer,
    traceId: trace.traceId,
    requestId: trace.requestId,
    trace: trace.getTrace(),
    steps,
    reportPlan,
    error
  };
}

/**
 * 将工具输出压缩成 Week 1 可读回答，保留 mock source 提示。
 *
 * @param toolName 工具名称。
 * @param result 工具结果。
 * @returns 面向用户的简短回答。
 */
function formatToolAnswer(toolName: string, result: unknown): string {
  if (toolName === "financial_metric_mock" && isRecord(result)) {
    const metrics = result.metrics;

    if (isRecord(metrics) && isRecord(metrics.net_profit) && isRecord(metrics.roe)) {
      return `已调用 financial_metric_mock。${String(result.ticker)} ${String(result.period)} 净利润为 ${String(metrics.net_profit.value)} ${String(metrics.net_profit.unit)}，ROE 为 ${String(metrics.roe.value)}%。数据来源：mock。`;
    }
  }

  if (toolName === "filing_search_mock" && isRecord(result) && Array.isArray(result.filings)) {
    const first = result.filings[0];

    if (isRecord(first)) {
      return `已调用 filing_search_mock。${String(result.ticker)} ${String(first.title)}：${String(first.snippet)} 数据来源：mock。`;
    }
  }

  return `已调用 ${toolName}，返回结果：${JSON.stringify(result)}`;
}

/**
 * 返回无需模型的本地解释，保证测试和无 API key 开发路径可运行。
 *
 * @param message 用户输入。
 * @returns mock chat 回答。
 */
function mockChatAnswer(message: string): string {
  if (message.includes("ROE") || message.includes("roe")) {
    return "ROE 是净资产收益率，用来衡量公司使用股东权益创造利润的效率。";
  }

  return "这是轻量问答路径的本地回答；需要实时数据时会进入工具路径。";
}

/**
 * 将未知异常规范成 AgentError。
 *
 * @param error 未知错误。
 * @param fallbackCode 默认错误码。
 * @param fallbackMessage 默认用户消息。
 * @returns AgentError。
 */
function toAgentError(error: unknown, fallbackCode: AgentError["code"], fallbackMessage: string): AgentError {
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    return {
      code: error.code as AgentError["code"],
      message: error.message,
      details: isRecord(error.details) ? error.details : undefined
    };
  }

  if (error instanceof Error) {
    const parsed = parseJsonError(error.message);

    if (parsed) {
      return {
        code: fallbackCode,
        message: fallbackMessage,
        details: parsed
      };
    }

    return {
      code: fallbackCode,
      message: error.message
    };
  }

  return {
    code: fallbackCode,
    message: fallbackMessage
  };
}

/**
 * 将 LLM 错误映射成 AgentError，保留供应商诊断但不包含密钥。
 *
 * @param error LLM client 错误。
 * @returns AgentError。
 */
function toModelAgentError(error: LlmError): AgentError {
  return {
    code: error.code === "json_parse_error" ? "json_parse_error" : "model_error",
    message: error.message,
    details: {
      llmCode: error.code,
      ...error.details
    }
  };
}

/**
 * 标准化 maxSteps，非法或小于 0 的值按 0 处理以触发结构化失败。
 *
 * @param maxSteps 用户传入的最大步骤数。
 * @returns 可比较的整数步数。
 */
function normalizeMaxSteps(maxSteps: number | undefined): number {
  if (maxSteps === undefined) {
    return DEFAULT_MAX_STEPS;
  }

  if (!Number.isFinite(maxSteps)) {
    return 0;
  }

  return Math.max(0, Math.floor(maxSteps));
}

/**
 * 生成 trace event id，避免引入 UUID 依赖。
 *
 * @param traceId 当前 trace id。
 * @param label 事件标签。
 * @returns 稳定前缀的事件 id。
 */
function createTraceEventId(traceId: string, label: string): string {
  return `${traceId}_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 计算步骤耗时并保留两位小数。
 *
 * @param startedAt performance.now 起始值。
 * @returns 毫秒耗时。
 */
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

/**
 * 生成可写入 trace 的短文本，避免记录过长输入或输出。
 *
 * @param value 原始文本。
 * @returns 截断后的文本。
 */
function preview(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

/**
 * 安全写入 trace，观测失败不影响主流程。
 *
 * @param trace trace recorder。
 * @param event trace event。
 */
function recordTrace(trace: TraceRecorder, event: Parameters<TraceRecorder["record"]>[0]): void {
  try {
    trace.record(event);
  } catch {
    // trace 是旁路观测能力，不能让记录失败打断 Agent 主流程。
  }
}

/**
 * 判断未知值是否为普通对象，便于格式化工具输出和错误 details。
 *
 * @param value 未知值。
 * @returns 是否为 record。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 尝试解析错误消息中的 JSON，兼容 router 模型结构化输出失败。
 *
 * @param value 错误消息。
 * @returns 解析出的对象或 undefined。
 */
function parseJsonError(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
